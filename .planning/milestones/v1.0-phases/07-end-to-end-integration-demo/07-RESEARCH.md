# Phase 7: End-to-End Integration + Demo - Research

**Researched:** 2026-03-08
**Domain:** Integration wiring, E2E testing, backward compatibility
**Confidence:** HIGH

## Summary

Phase 7 is an integration phase, not a greenfield implementation phase. All individual subsystems exist and are tested (573 tests across 49 files). The work centers on three gaps: (1) the orchestrator worker does not integrate validation or output collection, (2) there is no tracker write-back on completion (auto-close, done labels, PR creation), and (3) there are no E2E tests proving the full flow works end-to-end with a mock GitHub API.

The codebase is well-structured for this integration. `executeWorker` in `src/orchestrator/worker.ts` already calls `prepareExecution` from the shared single-agent path, creates containers, runs agents, and posts comments. The missing pieces are: calling `runValidationLoop` before declaring success, calling `collectOutput` (specifically `collectGitOutput`) to extract branch info, enriching the comment with validation results and branch name, adding auto-close/done-label write-back to the dispatcher, and wiring validation steps from WORKFLOW.md config into the orchestrated run plan.

**Primary recommendation:** Three plans: (1) Worker integration -- add validation loop + output collection + enriched write-back to worker/dispatcher, (2) Backward compatibility + example WORKFLOW.md, (3) E2E test with mock GitHub API server + demo documentation.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| R7.1 | Setup: user configures forgectl.yaml + WORKFLOW.md, runs `forgectl orchestrate` | Already working. `forgectl orchestrate` command exists, loads WORKFLOW.md, starts Orchestrator. Needs example WORKFLOW.md with validation steps. |
| R7.2 | Execution loop: poll -> claim -> workspace -> agent -> validation -> retry | Worker exists but skips validation. Need to wire `runValidationLoop` into `executeWorker`. Validation steps must come from WORKFLOW.md front matter or config. |
| R7.3 | Completion: commits to branch, posts comment, optionally creates PR/closes issue | Worker posts basic comment. Need: `collectGitOutput` for branch extraction, enriched comment with validation+branch, auto-close via `tracker.updateState`, done label via `tracker.updateLabels`. |
| R7.4 | Error handling: agent failure -> backoff, stall -> kill+retry, issue closed -> stop, rate limit -> backoff | Already implemented in dispatcher.ts and reconciler.ts. Needs E2E test coverage to verify. |
| NF1 | Backward compatibility: `forgectl run` and `forgectl pipeline` still work | Need explicit verification tests. Both commands are independent code paths. |
</phase_requirements>

## Standard Stack

### Core (already in project)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | (existing) | Test framework | Already configured, 573 tests |
| fastify | (existing) | HTTP server for mock GitHub API in tests | Already used for daemon |
| dockerode | (existing) | Container operations | Project standard |
| zod | (existing) | Schema validation | Project standard |

### Supporting (no new dependencies needed)
This phase requires zero new npm dependencies. All integration uses existing subsystems.

## Architecture Patterns

### Current Worker Flow (what exists)
```
dispatchIssue -> executeWorkerAndHandle -> executeWorker
  1. ensureWorkspace
  2. runBeforeHook
  3. buildOrchestratedRunPlan (validation.steps = [] hardcoded!)
  4. prepareExecution (container, creds, network)
  5. createAgentSession -> invoke
  6. buildResultComment (no validation, no branch)
  7. runAfterHook
  8. cleanupRun
```

### Target Worker Flow (what's needed)
```
dispatchIssue -> executeWorkerAndHandle -> executeWorker
  1. ensureWorkspace
  2. runBeforeHook
  3. buildOrchestratedRunPlan (validation.steps from config/WORKFLOW.md!)
  4. prepareExecution (container, creds, network)
  5. createAgentSession -> invoke
  6. runValidationLoop (NEW - if validation steps configured)
  7. collectGitOutput (NEW - extract branch name, commit info)
  8. buildResultComment (ENRICHED - validation results + branch)
  9. runAfterHook
  10. cleanupRun
```

### Dispatcher Write-Back Flow (what's needed)
```
After successful worker completion:
  1. postComment (existing - now with enriched data)
  2. If auto_close: tracker.updateState(issueId, "closed") (NEW)
  3. If done_label: tracker.updateLabels(issueId, [done_label], [in_progress_label]) (NEW)
```

### E2E Test Architecture
```
test/integration/e2e-orchestration.test.ts
  - Fastify mock GitHub API server (in-process)
  - Mock TrackerAdapter that delegates to the mock server
  - Mock AgentSession that simulates work completion
  - Full Orchestrator with real state machine, real scheduler
  - Assertions on mock server received requests (comments posted, labels updated)
```

### Anti-Patterns to Avoid
- **Don't run real Docker in E2E tests.** Mock the agent session and container creation. The unit tests for individual subsystems already cover Docker operations.
- **Don't modify the existing `executeSingleAgent` path.** The orchestrated worker path is separate from `forgectl run`. Keep them independent.
- **Don't add validation steps to buildOrchestratedRunPlan hardcoded.** They must come from config (WORKFLOW.md front matter or forgectl.yaml).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Validation in worker | Custom validation logic | `runValidationLoop` from `src/validation/runner.ts` | Already handles retry, feedback formatting, re-invocation |
| Output collection | Custom git output extraction | `collectGitOutput` from `src/output/git.ts` | Already handles branch extraction, commit listing |
| Mock HTTP server | nock/msw/custom fetch mock | In-process Fastify server | Already used in project, provides real HTTP semantics |
| Comment formatting | Custom markdown builder | `buildResultComment` from `src/orchestrator/comment.ts` | Already exists, just needs branch + validation fields populated |

## Common Pitfalls

### Pitfall 1: Validation requires container reference
**What goes wrong:** `runValidationLoop` needs a `Docker.Container` reference to exec validation commands inside the container. The worker currently closes the session and cleans up immediately after agent invocation.
**Why it happens:** The validation loop must run INSIDE the same container the agent worked in.
**How to avoid:** Call `runValidationLoop` BEFORE `session.close()` and BEFORE `cleanupRun`. The container must still be alive for validation commands to execute.

### Pitfall 2: Validation loop needs adapter, not session
**What goes wrong:** `runValidationLoop` signature takes `AgentAdapter` + `AgentOptions` + `agentEnv`, not `AgentSession`.
**Why it happens:** The validation loop re-invokes the agent via `invokeAgent` (not via session) when fixes are needed.
**How to avoid:** Keep the adapter/options/env from `prepareExecution` and pass them to `runValidationLoop`. The session and validation loop are separate invocation paths into the same container.

### Pitfall 3: Worker session field is null in running map
**What goes wrong:** `state.running.set(issue.id, { session: null as never, ... })` -- the session is created inside `executeWorker`, not in `dispatchIssue`. The reconciler calls `worker.session.close()` which would NPE.
**Why it happens:** Design decision to manage session inside worker, but reconciler needs to close it externally.
**How to avoid:** Either (a) expose session back to caller after creation, or (b) store an AbortController/kill signal instead. The current code already has this issue -- it exists in Phase 5 implementation.

### Pitfall 4: collectGitOutput needs container still running
**What goes wrong:** `collectGitOutput` (from `src/output/git.ts`) uses `container.getArchive` to extract git data. Container must be alive.
**Why it happens:** Output collection happens after agent completes but before container cleanup.
**How to avoid:** Sequence: agent invoke -> validation loop -> collect output -> cleanup container.

### Pitfall 5: Backward compatibility with forgectl run
**What goes wrong:** Changes to shared code (e.g., `prepareExecution`, config schema) could break `forgectl run` or `forgectl pipeline`.
**Why it happens:** Worker uses `prepareExecution` from `orchestration/single.ts` which is also used by `forgectl run`.
**How to avoid:** Don't modify `prepareExecution`. The worker already calls it correctly. Add validation/output steps in the worker only, not in shared code. Run existing test suite as backward compat check.

### Pitfall 6: WORKFLOW.md validation steps not wired to orchestrated plan
**What goes wrong:** `buildOrchestratedRunPlan` hardcodes `validation: { steps: [], on_failure: "abandon" }`. Even if WORKFLOW.md has validation config, it's ignored.
**Why it happens:** Phase 5 implementation deferred validation integration to Phase 7.
**How to avoid:** Accept validation config as parameter to `buildOrchestratedRunPlan`. Source it from WORKFLOW.md front matter (via config merge) or from forgectl.yaml workflow definition.

## Code Examples

### Current buildOrchestratedRunPlan gap (from src/orchestrator/worker.ts)
```typescript
// Lines 57-59: validation is hardcoded empty
validation: { steps: [], on_failure: "abandon" },
// Lines 91-94: also hardcoded
validation: {
  steps: [],
  onFailure: "abandon",
},
```

### runValidationLoop signature (from src/validation/runner.ts)
```typescript
export async function runValidationLoop(
  container: Docker.Container,
  plan: RunPlan,
  adapter: AgentAdapter,
  agentOptions: AgentOptions,
  agentEnv: string[],
  logger: Logger
): Promise<ValidationResult>
```

### TrackerAdapter write-back methods (from src/tracker/types.ts)
```typescript
postComment(issueId: string, body: string): Promise<void>;
updateState(issueId: string, state: string): Promise<void>;
updateLabels(issueId: string, add: string[], remove: string[]): Promise<void>;
```

### CommentData already supports validation + branch (from src/orchestrator/comment.ts)
```typescript
export interface CommentData {
  status: AgentStatus;
  durationMs: number;
  agentType: string;
  attempt: number;
  tokenUsage: TokenUsage;
  validationResults?: Array<{ name: string; passed: boolean; error?: string }>;
  branch?: string;
}
```

### Config already has auto_close and done_label (from src/config/schema.ts)
```typescript
// TrackerConfigSchema already defines:
auto_close: z.boolean().default(false),
done_label: z.string().optional(),
```

## Key Integration Gaps (Ordered by Implementation)

### Gap 1: Validation steps in orchestrated runs
- `buildOrchestratedRunPlan` hardcodes empty validation steps
- Need: accept validation config from WORKFLOW.md front matter or forgectl.yaml
- WORKFLOW.md front matter schema does NOT currently have a `validation` section
- Need to add `validation` to `WorkflowFrontMatterSchema` (steps array + on_failure)
- Config merge chain: CLI flags > WORKFLOW.md > forgectl.yaml > defaults

### Gap 2: Validation loop in worker
- `executeWorker` does not call `runValidationLoop`
- Need: after agent invoke, if plan has validation steps, run the loop
- Requires keeping container alive until after validation
- Requires adapter + agentOptions + agentEnv (available from `prepareExecution`)

### Gap 3: Output collection in worker
- `executeWorker` does not call `collectGitOutput` or `collectFileOutput`
- Need: after validation, collect output for branch name + commit info
- `collectGitOutput` needs container reference (still alive at this point)

### Gap 4: Enriched write-back
- `buildResultComment` already supports `validationResults` and `branch` but they are never populated
- Dispatcher posts comment but does not auto-close or add done label
- Need: populate comment fields, add auto-close and done-label logic

### Gap 5: E2E test
- No integration test for the full orchestrator flow
- Need: mock GitHub API (Fastify), mock agent execution, verify comment + label + state changes
- Pattern: similar to existing `board-mixed-e2e.test.ts` and `pipeline-mixed-e2e.test.ts`

### Gap 6: Example WORKFLOW.md
- No example WORKFLOW.md for code review workflow
- Need: front matter with tracker config, agent settings, validation steps, prompt template

### Gap 7: Backward compatibility verification
- Need explicit test that `forgectl run` still resolves plans correctly
- Need explicit test that `forgectl pipeline` commands still work
- Existing test suite passing is strong evidence but explicit verification is better

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest |
| Config file | `vitest.config.ts` |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npx vitest run` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| R7.1 | WORKFLOW.md + forgectl.yaml configures orchestrator | unit | `npx vitest run test/unit/workflow-file.test.ts -x` | Existing (needs extension) |
| R7.2 | Worker runs validation loop after agent invoke | unit | `npx vitest run test/unit/orchestrator-worker.test.ts -x` | Existing (needs extension) |
| R7.3 | Worker posts enriched comment, auto-closes, adds done label | unit | `npx vitest run test/unit/orchestrator-dispatcher.test.ts -x` | Existing (needs extension) |
| R7.4 | Error handling: backoff, stall, state change | unit | `npx vitest run test/unit/orchestrator-reconciler.test.ts -x` | Existing |
| NF1 | Backward compat: run + pipeline still work | integration | `npx vitest run test/integration/backward-compat.test.ts -x` | Wave 0 |
| R7.2+R7.3 | Full E2E: issue -> dispatch -> validate -> comment | integration | `npx vitest run test/integration/e2e-orchestration.test.ts -x` | Wave 0 |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest run`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/integration/e2e-orchestration.test.ts` -- full orchestrator E2E with mock GitHub API
- [ ] `test/integration/backward-compat.test.ts` -- verify `forgectl run` plan resolution still works

## Open Questions

1. **Validation steps in WORKFLOW.md front matter**
   - What we know: `WorkflowFrontMatterSchema` does not have a `validation` section. The `WorkflowSchema` (for built-in workflows) has `validation.steps` and `validation.on_failure`.
   - What's unclear: Should WORKFLOW.md front matter support inline validation step definitions, or should it reference a workflow name that has validation?
   - Recommendation: Add a `validation` section to the front matter schema matching the pattern in `WorkflowSchema`. This is the most direct approach and aligns with "WORKFLOW.md is the single source of truth for orchestrated runs."

2. **Worker session null in running map**
   - What we know: `state.running.set(issue.id, { session: null as never, ... })` in dispatcher.ts. Reconciler calls `worker.session.close()`.
   - What's unclear: Does this cause NPE in reconciler when the worker is still setting up?
   - Recommendation: Store a `close: () => Promise<void>` callback instead, initially a no-op, updated by worker once session is created. This is a targeted fix within the worker integration work.

## Sources

### Primary (HIGH confidence)
- Direct codebase inspection of all relevant source files
- `src/orchestrator/worker.ts` -- current worker implementation (no validation, no output collection)
- `src/orchestrator/dispatcher.ts` -- current dispatch/write-back (comment only, no auto-close)
- `src/orchestrator/comment.ts` -- CommentData interface (already supports validation + branch fields)
- `src/validation/runner.ts` -- runValidationLoop signature and behavior
- `src/tracker/types.ts` -- TrackerAdapter interface with postComment, updateState, updateLabels
- `src/config/schema.ts` -- auto_close, done_label config fields exist
- `src/workflow/workflow-file.ts` -- WORKFLOW.md parser, front matter schema

### Secondary (MEDIUM confidence)
- Existing test patterns in `test/integration/board-mixed-e2e.test.ts` for E2E test architecture

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies, all integration of existing code
- Architecture: HIGH - gaps are clearly identified from codebase inspection
- Pitfalls: HIGH - derived from actual code analysis of function signatures and data flow

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (stable - internal integration, no external dependency changes)
