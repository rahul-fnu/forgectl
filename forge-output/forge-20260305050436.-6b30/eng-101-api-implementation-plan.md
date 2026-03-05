# ENG-101 Implementation Plan (API)

## Objective
Deliver the `api` portion of ENG-101 to support reliable pipeline rerun behavior, checkpoint hydration, and safe git fan-in handling while preserving existing non-rerun API behavior.

## Scope (API-owned)
- `POST /pipelines/:id/rerun`
- CLI command surface for pipeline rerun (`src/cli/pipeline.ts`)
- API contract surfaced in types, validation, and docs for rerun options
- API tests that verify request validation, status codes, and rerun orchestration options

## Plan
1. Lock contract and validation first.
   - Confirm and document `fromNode` and `checkpointRunId` semantics.
   - Validate `fromNode` exists before execution and return `400` when missing/invalid.
   - Default `checkpointRunId` to `:id` when not supplied.

2. Add checkpoint-aware rerun orchestration.
   - Extend rerun request handling to pass `checkpointSourceRunId` into pipeline execution options.
   - Ensure rerun from-node requests execute `fromNode`+descendants, and use checkpoint hydration for skipped ancestors.
   - Keep non-rerun runs behavior unchanged.

3. Improve API-side safety for rerun execution context.
   - Add explicit warnings/errors in CLI flow for missing `--pipeline-run`.
   - Ensure rerun endpoint forwards strict dependency/skip/failure policy metadata and does not mask blocked execution as success.

4. Expose observability and error clarity.
   - Add structured error responses for invalid node selection, missing source run, and conflict/invalid checkpoint cases.
   - Include skipped/blocked node reasons in response payload where already surfaced by execution state.

5. Add API and integration test coverage.
   - Unit/integration tests for:
     - valid/invalid `fromNode`
     - default `checkpointRunId`
     - CLI without `--pipeline-run` warning/guard behavior
     - rerun orchestration passes correct options to executor
     - API responses for dependency-blocked reruns

## Exit Criteria
- `POST /pipelines/:id/rerun` enforces valid `fromNode` and returns precise errors.
- API routes pass checkpoint source run metadata into execution by default (`:id`).
- CLI rerun behavior for `pipeline-run` is explicit and safe.
- Dependency-blocking and rerun status results are observable via API responses.
- Regression coverage exists for existing endpoint behavior and new rerun paths.
