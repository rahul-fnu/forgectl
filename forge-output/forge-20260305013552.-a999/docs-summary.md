# Pipeline Reliability + Mixed-Workflow Hardening: Change Summary

## Changed Files

- `SPEC.md`
- `TASK.md`
- `.claude/ralph-loop.local.md` (removed)
- `examples/mixed-workflow-e2e.yaml` (new)
- `.claude/settings.local.json` (new local command allowlist config)
- `forge-output/` (new untracked pipeline output artifacts)

## Summary of What Changed

### 1) Core pipeline spec was rewritten to replace the prior broad roadmap
- `SPEC.md` is now a focused behavior spec for reliability hardening (v2.1).
- Scope shifted from documenting feature breadth to explicit correctness requirements and acceptance gates.
- The old general phase roadmap was replaced with concrete functional, API, and data-contract requirements.

### 2) Task plan became an implementation contract
- `TASK.md` changed from generic pipeline setup guidance to a seven-phase execution plan.
- It now defines exact required behaviors, source files to touch, validation commands, and acceptance checks.
- Includes explicit negative/edge cases (conflicts, skip propagation, branch safety, and mixed artifact handling).

### 3) Local control file was removed
- `.claude/ralph-loop.local.md` was deleted.
- The removed file previously instructed the agent loop with a completion contract.

### 4) Mixed-workflow E2E scenario was added
- `examples/mixed-workflow-e2e.yaml` now defines a full mixed pipeline to exercise files-to-git, git-to-files, and files fan-in behavior.
- It includes overlapping content/artifact paths to validate collision-resistant, namespaced file propagation.

## Behavioral Changes Captured by the Update

### Rerun + checkpointing
- Rerun is now defined as ancestry-based instead of topological-prefix based.
- Skipped ancestors are expected to be hydrated from checkpoint metadata.
- `NodeExecution` state should treat hydrated ancestors as successful where appropriate for downstream input resolution.
- API rerun validation now requires a valid `fromNode`, defaults checkpoint source to the target run ID, and returns `400` on invalid nodes.

### Dependency propagation
- Downstream execution is blocked unless all dependencies are effectively successful.
- `failed` or `skipped` (without successful hydration) dependencies must skip downstream nodes with explicit reasons.

### Git fan-in safety
- Host repo state must be restored in all cases.
- Temp branches/work must be cleaned up in success and failure paths.
- Git-merging operations that mutate repo state must be serialized per repository.
- Merge conflicts must fail the node clearly without leaving partial merge state.

### Mixed-workflow file handling
- files-to-files must preserve paths and namespace upstream files by dependency node to prevent collisions.
- Mixed binary and text files must be passed through without UTF-8 assumptions in file mode.
- Context extraction for files/git transitions must classify text vs binary and use manifests for non-text or large files.

### Checkpoint metadata and consistency
- Unified checkpoint naming for commit identity (`sha`/`commitSha`) is required.
- Files checkpoints must persist enough metadata (`outputDir`, file list, timestamps as applicable) for deterministic hydration.

## Implementation Note

This working copy currently includes specification and task updates plus generated output files, but no tracked source-code changes were present in `src/` at the point this summary was generated.
