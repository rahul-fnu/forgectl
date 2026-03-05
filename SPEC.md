# BUILD SPEC UPDATE: Pipeline Reliability + Mixed-Workflow Hardening (v2.1)

## 1. Purpose

This spec supersedes prior broad roadmap phases for current work. Baseline pipeline/UI functionality exists. This update defines corrective behavior and test requirements needed for reliable production use.

Primary goals:

- Correct DAG rerun semantics with checkpoint-backed hydration.
- Deterministic dependency propagation.
- Safe git fan-in in shared host repos.
- Mixed-workflow piping that handles multiple file types (text + binary).
- Strong E2E coverage for mixed-mode pipelines.

## 2. Baseline Assumptions

Already implemented (do not redesign):

- Pipeline DAG parsing/validation/execution.
- Mixed-mode resolver skeleton (`git->git`, `files->files`, `files->git`, `git->files`).
- Daemon pipeline endpoints + SSE.
- Basic builder/execution UI.

This spec is a behavior-correction and test-hardening pass.

## 3. Functional Requirements

## 3.1 Rerun Semantics

### FR-1: Ancestry-based rerun

`rerun from node X` must use DAG ancestry, not topo index prefix.

- Ancestors of `X` are eligible for skip/hydration.
- `X` and descendants of `X` execute.
- Nodes outside the execution subgraph remain skipped.

### FR-2: Checkpoint-backed hydration

Rerun must reconstruct upstream outputs from checkpoints so downstream input resolution is correct.

Add executor option:

```ts
checkpointSourceRunId?: string
```

Hydration behavior for skipped ancestors:

- git checkpoint => synthetic successful output containing `branch` and `sha/commitSha`.
- files checkpoint => synthetic successful output containing `outputDir` + file manifest.

Hydrated nodes must appear successful to `resolveNodeInput`.

### FR-3: API rerun validation

`POST /pipelines/:id/rerun` must:

- Validate `fromNode` exists in pipeline.
- Use `:id` as default `checkpointSourceRunId`.
- Return 400 on invalid/missing `fromNode`.

### FR-4: CLI rerun behavior clarity

`pipeline rerun` must clearly support checkpoint-backed runs:

- Add/ensure `--pipeline-run <id>` argument.
- If omitted, either reject or explicitly run in non-checkpoint mode with warning.

## 3.2 Dependency Propagation

### FR-5: Strict dependency gate

A node can execute only if every dependency is effectively successful.

Treat as blocking failures:

- dependency status `failed`
- dependency status `skipped` without hydrated successful result
- dependency completed with `result.success=false`

Blocked downstream node status = `skipped` with explicit reason.

## 3.3 Git Fan-In Safety

### FR-6: Host repo restoration

Fan-in prep must always restore original repo ref/branch in `finally`, even on errors.

### FR-7: Temp branch/work cleanup

Fan-in temp branches/resources must be deleted when no longer needed.

### FR-8: Per-repo serialization

All git-mutating operations in pipeline executor must be serialized per repo path:

- fan-in merge prep
- merge-back of node output branch
- branch checkout/reset actions

No concurrent branch mutation in same repo.

### FR-9: Conflict handling

If auto-resolution cannot produce a safe state, node fails with actionable conflict detail.

No partial merge state should leak to later nodes.

## 3.4 Mixed-Workflow File Handling

### FR-10: files->files path preservation

Downstream files-mode nodes must receive upstream outputs with structure preserved.

- Preserve relative paths from upstream output roots.
- Namespace by upstream node ID to avoid collisions.
- Do not flatten by basename.

### FR-11: Multi-type file support

files->files piping must include binary and text files.

No UTF-8 decoding assumptions in this path.

### FR-12: files->git and git->files context strategy

Context materialization must support heterogeneous artifacts:

- Text files within size budget: inline into prompt context.
- Binary/large files: no raw inline; include as artifacts with manifest entries.

Manifest should include at minimum:

- source node ID
- relative path
- detected type (text/binary)
- size
- change kind (for git-derived context: added/modified/deleted/renamed)

## 3.5 Checkpoint Metadata

### FR-13: SHA field consistency

Checkpoint git metadata must persist actual output commit SHA consistently.

No `sha` vs `commitSha` mismatch.

### FR-14: Files checkpoint hydration metadata

Files checkpoints must persist enough metadata to rebuild synthetic outputs deterministically:

- output directory
- file list

## 4. Data Contract Updates

## 4.1 Executor options

```ts
interface PipelineExecutorOptions {
  fromNode?: string;
  checkpointSourceRunId?: string;
  repo?: string;
  maxParallel?: number;
  dryRun?: boolean;
  verbose?: boolean;
}
```

## 4.2 Node state expectations

Hydrated/skipped ancestor nodes should include traceable metadata (example):

```ts
hydratedFromCheckpoint?: {
  pipelineRunId: string;
  nodeId: string;
}
```

## 4.3 Checkpoint metadata

```ts
interface CheckpointRef {
  nodeId: string;
  pipelineRunId: string;
  timestamp: string;
  branch?: string;
  commitSha?: string;
  outputDir?: string;
  outputFiles?: string[];
}
```

## 5. API Contract Updates

## 5.1 POST /pipelines/:id/rerun

Request:

```json
{
  "fromNode": "node-id",
  "repo": "/optional/repo/override",
  "verbose": true,
  "checkpointRunId": "optional-override-run-id"
}
```

Behavior:

- `fromNode` required and must exist.
- `checkpointRunId` defaults to `:id`.
- New run created with checkpoint-backed hydration.

Errors:

- 400 invalid/missing `fromNode`
- 404 unknown pipeline run id

## 6. Test Plan (Required)

## 6.1 Unit tests

Must cover:

- ancestry rerun selection on non-linear DAGs
- checkpoint hydration correctness (git/files)
- dependency skip/fail propagation
- per-repo lock serialization
- files->files path/collision behavior
- text/binary classification and manifest generation
- checkpoint SHA persistence

## 6.2 Integration tests (engine mocked)

Must validate resolved inputs and node state transitions for:

- content(files) -> code(git)
- code(git) -> content(files)
- files fan-in with collisions
- rerun from node with checkpoint hydration

## 6.3 Live E2E tests (docker enabled)

Add dedicated mixed pipeline E2E suite/script with at least:

1. `files->git` including `.md`, `.json`, `.png`
2. `git->files` including code + binary change
3. `files->files` fan-in with overlapping filenames

Assertions:

- expected node statuses
- expected downstream artifact/context counts and paths
- repo restored to original ref after execution
- rerun from node reproduces output using checkpoints

## 7. Non-Functional Requirements

- Deterministic behavior across repeated runs.
- No host repo corruption or lingering temp branches after failures.
- Clear error messaging for conflicts/hydration failures.
- Backward compatibility for non-rerun `pipeline run` path.

## 8. Acceptance Criteria

- [ ] Rerun uses ancestry + checkpoint hydration.
- [ ] API rerun validates node id and defaults checkpoint source run.
- [ ] Dependency gate prevents invalid downstream execution.
- [ ] Git fan-in is serialized and repo state is restored.
- [ ] Mixed file-type pipelines work for files->files, files->git, git->files.
- [ ] Checkpoint SHA metadata is consistent and reloadable.
- [ ] Unit + integration + live E2E tests added and passing.

## 9. Verification Commands

```bash
npm run typecheck
FORGECTL_SKIP_DOCKER=true npm test
npm run build

# live e2e (docker)
FORGECTL_SKIP_DOCKER=false npm test -- test/integration/pipeline-mixed-e2e.test.ts
```
