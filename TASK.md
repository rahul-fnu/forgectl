# TASK: Pipeline Reliability + Mixed-Workflow E2E Hardening

This task replaces the previous broad v2 plan. Focus only on the gaps below.

## Goal

Fix correctness and reliability issues in pipeline rerun/checkpoint behavior, mixed-workflow piping, and git fan-in safety. Add deterministic tests and live E2E coverage, especially for mixed file types.

## Scope

- In scope:
  - `src/pipeline/*`
  - `src/daemon/routes.ts`
  - `src/cli/pipeline.ts` and CLI wiring
  - `src/container/workspace.ts`
  - `src/context/*` and prompt/context handling
  - Pipeline unit/integration/e2e tests
  - README pipeline behavior updates (only sections affected by these changes)
- Out of scope:
  - New dashboard features
  - New workflow types
  - Agent/model changes

---

## Phase 1: Fix Rerun + Checkpoint Semantics

### 1A. Rerun must be ancestry-based, not topological-prefix-based

Current behavior skips all nodes before `fromNode` in topo order. This is incorrect for DAGs.

Implement:

- Add graph helpers:
  - `isAncestor(a, b)`
  - `collectAncestors(nodeId)`
  - `collectDescendants(nodeId)`
- For rerun-from-node:
  - Only ancestors of `fromNode` are skipped.
  - Unrelated branches are skipped only if not needed by any executed descendant.

### 1B. Rerun must hydrate from checkpoints

When rerunning from an existing pipeline run, skipped ancestor nodes must contribute outputs via checkpoints.

Implement:

- Executor option: `checkpointSourceRunId?: string`
- For each skipped ancestor:
  - Load checkpoint metadata.
  - Reconstruct minimal successful `NodeExecution.result.output`:
    - git: branch (+ sha when available)
    - files: output dir + file list
- Downstream `resolveNodeInput` must see hydrated outputs exactly as if upstream nodes completed.

### 1C. API/CLI validation for rerun

Implement:

- `POST /pipelines/:id/rerun`:
  - Validate `fromNode` exists in pipeline.
  - Default checkpoint source run to `:id`.
  - Return 400 on invalid node.
- CLI rerun:
  - Add/ensure `--pipeline-run <id>` support for checkpoint-backed rerun.
  - If omitted, print explicit warning that rerun is from scratch (or require it).

---

## Phase 2: Dependency Failure/Skip Propagation

### 2A. Strict dependency gate

Downstream node may run only if all dependencies are effectively successful.

Rules:

- Dependency status `failed` => downstream `skipped` with reason.
- Dependency status `skipped` without hydrated successful output => downstream `skipped`.
- Dependency status `completed` with `result.success=false` => downstream `skipped`.

Add explicit skip reasons in node state.

---

## Phase 3: Make Git Fan-In Safe and Deterministic

### 3A. Protect host repo state

Current merge flow mutates checkout and may leave temp branches/conflicts behind.

Implement:

- Capture original HEAD/ref before fan-in prep.
- Use dedicated temp branch naming per pipeline run + node.
- Always restore original ref in `finally`.
- Cleanup temp branches/work state on success/failure.

### 3B. Serialize git mutations per repo

Parallel git nodes sharing one repo must not race on checkout/merge.

Implement a per-repo async lock for:

- upstream branch merge prep
- merge-back of completed node branch into host repo

### 3C. Conflict behavior

If fan-in merge fails and cannot be safely resolved, fail node clearly with conflict detail. Do not continue with half-merged repo state.

---

## Phase 4: files->files Path + Multi-Type File Handling

### 4A. Preserve structure and avoid collisions

Current file input staging flattens by basename.

Implement:

- Preserve relative paths from upstream outputs.
- Namespace upstream files by dependency ID (e.g., `/input/upstream/<depId>/...`).
- Avoid filename collisions deterministically.

### 4B. Support mixed file types

Ensure files->files piping includes text and binary files. No UTF-8-only assumptions in this path.

---

## Phase 5: Improve Mixed-Mode Context Materialization (files->git and git->files)

### 5A. Text vs binary classification

Implement context materialization rules:

- Text files: inline to prompt context (size-limited).
- Binary/large files: do not inline raw bytes; provide file artifact plus manifest entry.

### 5B. Git->files extraction improvements

When extracting changed files from git outputs:

- Handle add/modify/delete/rename in summary.
- Include only readable text for inline sections.
- Preserve metadata for non-text files in manifest.

---

## Phase 6: Checkpoint Metadata Correctness

### 6A. Commit SHA field consistency

Fix mismatch between git output `sha` and checkpoint `commitSha` persistence.

### 6B. Files checkpoint metadata

Store enough metadata for deterministic hydration:

- output dir
- file list
- timestamps optional

---

## Phase 7: Tests (Required)

## 7A. Unit tests

Add/extend tests for:

- rerun ancestry logic on non-linear DAGs
- checkpoint hydration into `nodeStates`
- dependency skip propagation
- per-repo lock behavior (no concurrent git mutation)
- files->files path preservation/collision handling
- text/binary context classification
- checkpoint sha field persistence

## 7B. Integration tests (mocked execution engine)

Add tests covering:

- content(files) -> code(git) -> content(files)
- fan-in with mixed upstream output modes
- rerun from node using existing run checkpoints

Assert resolved inputs and node statuses, not just call counts.

## 7C. Live E2E (docker-enabled)

Add live E2E script/test for three pipelines:

1. files->git
- Node A (`content`): emits `spec.md`, `schema.json`, `diagram.png`
- Node B (`code`): uses context to implement endpoint

2. git->files
- Node A (`code`): edits `.ts` + `.md` + binary asset
- Node B (`content`): produces docs using extracted context/manifest

3. files->files fan-in
- Two upstream `content/research` nodes emit overlapping filenames and nested dirs
- Downstream `content` node receives both sets without collisions

Required assertions:

- Pipeline finishes with expected statuses.
- Downstream receives expected count/type of context/input artifacts.
- No repo left on temp branch after run.
- Rerun-from-node reproduces outputs using checkpoints.

---

## Verification Commands

```bash
npm run typecheck
FORGECTL_SKIP_DOCKER=true npm test
npm run build

# Docker/live only
FORGECTL_SKIP_DOCKER=false npm test -- test/integration/pipeline-mixed-e2e.test.ts
```

---

## Acceptance Criteria

- [ ] Rerun uses ancestry + checkpoint hydration correctly.
- [ ] API rerun validates `fromNode` and uses base run checkpoints by default.
- [ ] Dependency failures/skips never allow invalid downstream execution.
- [ ] Git fan-in is serialized, restores original repo state, and cleans temp branches.
- [ ] files->files preserves structure and handles mixed file types.
- [ ] files->git and git->files context handling supports text + binary via manifest strategy.
- [ ] Checkpoint SHA metadata is correct and reloadable.
- [ ] New unit/integration/live E2E tests cover all above behaviors.
