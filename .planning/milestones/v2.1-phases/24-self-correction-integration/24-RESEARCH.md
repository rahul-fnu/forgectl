# Phase 24: Self-Correction Integration - Research

**Researched:** 2026-03-13
**Domain:** Pipeline loop executor augmentation — no-progress detection, exclude enforcement, coverage parsing
**Confidence:** HIGH

## Summary

Phase 24 adds three behavioral features to `executeLoopNode` in `src/pipeline/executor.ts`: (1) no-progress detection via SHA-256 hash comparison of consecutive test outputs (CORR-05), (2) test file exclusion enforcement via post-execution `git diff` check with picomatch (CORR-02), and (3) coverage threshold variable `_coverage` injected into the `until` expression context (CORR-04). CORR-01 (test-fail/fix/retest pattern) and CORR-03 (progressive context) are already fully implemented in Phase 22 — those requirements are satisfied by the existing loop infrastructure and need only integration tests and YAML documentation to be considered done.

The single most important implementation decision: **`ValidationResult` and `ExecutionResult` do not surface validation step stdout**, so CORR-05 and CORR-04 require either extending `ExecutionResult` to include a `lastValidationOutput?: string` field (capturing combined stdout+stderr of the final validation pass), or extracting output via a different mechanism. This is a foundational decision that must be made in Plan 01 because both features depend on it.

**Primary recommendation:** Extend `ExecutionResult` with `lastValidationOutput?: string` (combined stdout+stderr from the final validation step run), then consume this field in `executeLoopNode` for hash comparison and coverage extraction. This is the minimal invasive approach — one new optional field on an existing interface.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**No-progress detection (CORR-05)**
- SHA-256 hash comparison of test command stdout+stderr between consecutive iterations only
- If iteration N's output hash matches iteration N-1's hash, abort immediately with "no progress detected" failure
- No cycle detection across non-consecutive iterations — consecutive-only catches the common stuck-agent case
- Failure message includes the repeated test output so users can see what the agent was stuck on
- Hash computed on raw test output (stdout+stderr), not on the progressive context file (which includes timestamps)

**Test file exclusion enforcement (CORR-02)**
- Post-execution git diff check after each fix agent iteration, directly in `executeLoopNode`
- Uses picomatch glob matching against the existing `repo.exclude` list from WORKFLOW.md — no new config surface
- If any excluded file was modified: step fails immediately with error naming the specific files modified
- Error format: "Fix agent modified excluded file(s): test/foo.test.ts, test/bar.test.ts" — no suggestion text
- After failing, excluded file modifications are reverted via `git checkout` before the next iteration starts
- Other (non-excluded) changes from the fix agent are left in place

**Coverage threshold parsing (CORR-04)**
- Regex parsing of test runner stdout for common coverage patterns (vitest, jest, istanbul/c8 formats)
- Coverage number injected as `_coverage` loop variable alongside `_status`, `_iteration`, etc.
- Users write until expressions like `_coverage >= 80` — consistent with the filtrex expression model
- When no coverage pattern is found in output: `_coverage = -1` (until expression stays false, loop continues)
- Exhaustion message includes final coverage: "Coverage target not met after N iterations (final: 72%, target: 80%)"

### Claude's Discretion
- Exact regex patterns for coverage extraction (vitest, jest, istanbul formats)
- How progressive context formats the iteration output (markdown structure, headers)
- Integration test structure and fixture design
- WORKFLOW.md self-correction pattern documentation format and examples
- Whether `_coverage` is always injected or only when the until expression references it

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CORR-01 | Test-fail → fix → retest pipeline pattern using loop nodes with failure output as context | Verified: loop + progressive context fully operational from Phase 22; needs integration test + YAML doc |
| CORR-02 | Fix agent excluded from modifying test files via WORKFLOW.md exclude list | Requires post-execution `git diff HEAD` in `executeLoopNode`; picomatch already in workspace.ts |
| CORR-03 | Each fix iteration includes history of all previous attempts (progressive context) | Verified: `progressiveContext` array in `executeLoopNode` already accumulates per-iteration files |
| CORR-04 | Coverage self-correction: loop until coverage >= threshold with structured output parsing | Requires `lastValidationOutput` on `ExecutionResult`; regex extraction; `_coverage` in untilCtx |
| CORR-05 | Clean exhaustion failure when max_iterations reached ("self-correction exhausted after N iterations") | Existing exhaustion message is present; CORR-05 per REQUIREMENTS.md also covers no-progress abort |
</phase_requirements>

## Standard Stack

### Core (all already in-tree, no new installs required)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:crypto` | built-in | SHA-256 hash of test output string for no-progress detection | Already imported pattern in executor.ts (`randomBytes`); `createHash` used in `src/utils/hash.ts` |
| `picomatch` | existing dep | Glob matching for excluded files after git diff | Already used in `src/container/workspace.ts`; same import pattern |
| `node:child_process` `execSync` | built-in | `git diff --name-only HEAD` and `git checkout` for exclude enforcement | Already imported and used in executor.ts for fan-in/merge operations |
| `filtrex` | existing dep | Evaluate `_coverage >= 80` until expressions | Already compiled for `_status`, `_iteration`, etc. in `evaluateCondition` |

### No New Dependencies
This phase requires zero new `npm install` calls. All primitives (`crypto`, `picomatch`, `execSync`, `filtrex`) are already present.

## Architecture Patterns

### Recommended File Touch Map
```
src/
├── orchestration/single.ts        # Add lastValidationOutput?: string to ExecutionResult
├── validation/runner.ts           # Capture + return combined stdout+stderr from final validation pass
├── pipeline/executor.ts           # Main integration: hash check, git diff check, _coverage injection
└── pipeline/condition.ts          # No changes needed (_coverage added via untilCtx, not type changes)

test/unit/
├── pipeline-self-correction.test.ts   # NEW: unit tests for CORR-02, CORR-04, CORR-05
└── pipeline-loop.test.ts              # Extend: CORR-03 progressive context already tested here
```

### Pattern 1: Surfacing Validation Output for No-Progress Detection and Coverage Parsing

**What:** Extend `ExecutionResult` with `lastValidationOutput?: string` containing combined stdout+stderr from the last validation step execution.

**When to use:** Required for both CORR-05 (hash comparison) and CORR-04 (coverage regex extraction). Both features need the raw text output of the test command.

**How to implement in `src/validation/runner.ts`:**

`ValidationResult` already has `stepResults` (name, passed, attempts) but no stdout. The `runValidationLoop` function collects `StepResult[]` which HAS `stdout` and `stderr` fields in the inner loop but throws them away before returning. Add a `lastOutput?: string` field to `ValidationResult`:

```typescript
// src/validation/runner.ts — extend ValidationResult
export interface ValidationResult {
  passed: boolean;
  totalAttempts: number;
  stepResults: Array<{
    name: string;
    passed: boolean;
    attempts: number;
  }>;
  lastOutput?: string;  // combined stdout+stderr from the last validation pass (final step run)
}
```

Then in `runValidationLoop`, capture the combined output from the last run of all steps and populate `lastOutput`. The simplest approach: capture `results` from the final pass (both passed and failed runs), concatenate all step stdout+stderr.

In `ExecutionResult` (src/orchestration/single.ts), the `validation: ValidationResult` field already carries this through — no change to `ExecutionResult` itself is needed if `ValidationResult.lastOutput` is added.

### Pattern 2: No-Progress Detection (CORR-05) in `executeLoopNode`

**What:** After each iteration completes, compare SHA-256 hash of `iterState.result?.validation?.lastOutput ?? ""` against the previous iteration's hash. If equal and neither hash is empty, abort.

**Where:** In `executeLoopNode`, after recording the iteration result and before evaluating the `until` expression.

**Key detail:** Hash on raw test output, not on the iteration output file (which includes timestamps). Store `lastOutputHash` as a local variable, updated each iteration.

```typescript
// Inside executeLoopNode, after recording iterRecord and before evaluating until:
import { createHash } from "node:crypto";

const currentOutput = iterState.result?.validation?.lastOutput ?? "";
const currentHash = createHash("sha256").update(currentOutput).digest("hex");

if (i > 1 && currentOutput !== "" && currentHash === lastOutputHash) {
  state.status = "failed";
  state.error = `Loop "${node.id}" aborted: no progress detected — identical test output on iterations ${i - 1} and ${i}:\n${currentOutput.slice(0, 500)}`;
  state.completedAt = new Date().toISOString();
  this.nodeStates.set(node.id, state);
  return;
}
lastOutputHash = currentHash;
```

Declare `let lastOutputHash = ""` before the for loop.

### Pattern 3: Test File Exclusion Enforcement (CORR-02) in `executeLoopNode`

**What:** After each iteration's `executeNode` call, run `git diff --name-only HEAD` in the repo, filter results against the exclude list using picomatch, fail + revert if any excluded files were modified.

**Where:** In `executeLoopNode`, after `await this.executeNode(iterationNode)` and before recording the iteration result.

**Requires:** The node must have a `repo` path available. The exclude list comes from `config.repo.exclude`.

```typescript
// After executeNode completes, before recording iterRecord:
const repoPath = node.repo ?? this.pipeline.defaults?.repo ?? this.options.repo;
const config = loadConfig();  // already called once per node in executeNode — consider caching
const excludePatterns = config.repo.exclude;

if (repoPath && excludePatterns.length > 0) {
  const isExcluded = picomatch(excludePatterns);
  let changedFiles: string[] = [];
  try {
    const diffOutput = execSync("git diff --name-only HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
    changedFiles = diffOutput ? diffOutput.split("\n").filter(Boolean) : [];
  } catch {
    // git not available or not a repo — skip check
  }

  const violations = changedFiles.filter(f => isExcluded(f));
  if (violations.length > 0) {
    // Revert excluded files only, leave other changes
    for (const file of violations) {
      try {
        execSync(`git checkout HEAD -- ${JSON.stringify(file)}`, { cwd: repoPath, stdio: "pipe" });
      } catch { /* ignore */ }
    }
    // Mark this iteration as failed with violation error
    const iterState = this.nodeStates.get(node.id)!;
    iterState.status = "failed";
    iterState.error = `Fix agent modified excluded file(s): ${violations.join(", ")}`;
    this.nodeStates.set(node.id, iterState);
  }
}
```

**Note:** `loadConfig()` is called inside `executeNode` already. To avoid double-loading, either pass `exclude` as a parameter to `executeLoopNode` or call `loadConfig()` once at the top of `executeLoopNode` and store locally.

### Pattern 4: Coverage Variable Injection (CORR-04) in `executeLoopNode`

**What:** Parse `lastOutput` for coverage percentage, inject as `_coverage` into the filtrex context alongside `_status`, `_iteration`, etc.

**Regex patterns to detect (Claude's discretion area):**

| Format | Example line | Regex |
|--------|-------------|-------|
| vitest | `All files | 72.34 |` | `/All files\s*\|\s*([\d.]+)/` |
| jest/istanbul text | `Statements   : 72.34% ( 100/137 )` | `/Statements\s*:\s*([\d.]+)%/` |
| c8/istanbul summary | `Lines        : 72.34% ( 100/137 )` | `/Lines\s*:\s*([\d.]+)%/` |
| Generic percentage | `72.34% coverage` | `/([\d.]+)%\s*coverage/i` |

Use the first match found, in order of specificity (vitest first, then jest, then generic). Return `-1` if no match.

```typescript
function extractCoverage(output: string): number {
  // vitest tabular format: "All files | 72.34 |"
  const vitestMatch = output.match(/All files\s*\|\s*([\d.]+)/);
  if (vitestMatch) return parseFloat(vitestMatch[1]);

  // jest/istanbul: "Statements   : 72.34% ( 100/137 )"
  const statementsMatch = output.match(/Statements\s*:\s*([\d.]+)%/);
  if (statementsMatch) return parseFloat(statementsMatch[1]);

  // c8/istanbul Lines: "Lines        : 72.34% ( 100/137 )"
  const linesMatch = output.match(/Lines\s*:\s*([\d.]+)%/);
  if (linesMatch) return parseFloat(linesMatch[1]);

  return -1;
}
```

Inject into `untilCtx`:
```typescript
const coverage = extractCoverage(iterState.result?.validation?.lastOutput ?? "");
const untilCtx = {
  ...upstreamCtx,
  _status: iterStatus,
  _iteration: i,
  _max_iterations: maxIterations,
  _first_iteration: i === 1 ? 1 : 0,
  _coverage: coverage,
} as unknown as Parameters<typeof evaluateCondition>[1];
```

**Exhaustion message with coverage context:** When the loop exhausts, if the until expression references `_coverage`, include the final coverage in the error:
```
"Coverage target not met after N iterations (final: 72%, target: 80%)"
```

Determining the "target" from the until expression is tricky — simpler approach: always include final coverage in the exhaustion message when `_coverage !== -1`.

### Pattern 5: Updated Exhaustion Message (CORR-05 exhaustion path)

The existing exhaustion message is:
```
Loop "my-loop" exhausted max_iterations (10) without "until" expression becoming true
```

With CORR-04 coverage context, the exhaustion message should include coverage when detected:
```typescript
const finalCoverage = extractCoverage(lastOutput);
if (finalCoverage >= 0) {
  state.error = `Loop "${node.id}" exhausted max_iterations (${maxIterations}) without "until" expression becoming true (final coverage: ${finalCoverage.toFixed(1)}%)`;
} else {
  state.error = `Loop "${node.id}" exhausted max_iterations (${maxIterations}) without "until" expression becoming true`;
}
```

### Anti-Patterns to Avoid

- **Don't hash the progressive context file for no-progress detection.** It contains timestamps that change every iteration, causing false no-progress results to never trigger.
- **Don't revert ALL changes after an exclusion violation.** Only revert the specific excluded files — other fix agent changes should be preserved for the next iteration attempt.
- **Don't call `loadConfig()` inside the inner iteration loop.** Call once at the top of `executeLoopNode` and use the cached value.
- **Don't throw on git not found.** The `git diff` check is best-effort — if the repo path is unavailable or git errors, silently skip the check (log a warning).
- **Don't make `_coverage` cause ConditionVariableError for non-coverage pipelines.** Inject `_coverage: -1` always — the filtrex `customProp` handler already handles this since the key IS in the context.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Glob matching for excluded files | Custom glob parser | `picomatch` (already imported in workspace.ts) | Same patterns WORKFLOW.md already uses for exclude |
| SHA-256 hashing | MD5 or JS hash function | `node:crypto` `createHash('sha256')` | Already the project pattern (hash.ts); consistent |
| Coverage regex | Full output parser | 3-4 targeted regex patterns | Output format is line-based; regex is sufficient and matches the project's "simple by default" philosophy |
| Expression evaluation | Custom parser | `filtrex` `evaluateCondition()` | Already handles `_coverage >= 80` via numeric comparison |

## Common Pitfalls

### Pitfall 1: `executeNode` overwrites `nodeStates` for the loop node
**What goes wrong:** `executeNode` calls `this.nodeStates.set(node.id, state)` using `node.id` — which for loop iterations is the same as the outer loop node ID. After each iteration, the node state is overwritten with the iteration result. `executeLoopNode` reads it back immediately after with `this.nodeStates.get(node.id)`.

**Why it happens:** The loop body re-uses the same node ID for each iteration (by design in Phase 22).

**How to avoid:** This is the existing pattern — `executeLoopNode` already reads `iterState = this.nodeStates.get(node.id)!` after each `await this.executeNode(iterationNode)`. The exclusion check and coverage extraction must happen in this same window, after `executeNode` returns and before `state.status` is reset to "loop-iterating".

**Warning signs:** If exclusion/coverage logic reads from `state` instead of `iterState`, it will see stale data.

### Pitfall 2: `state.status` reset timing
**What goes wrong:** After each `executeNode`, `executeLoopNode` resets `state.status = "loop-iterating"` to prevent the final iteration's status from leaking out. The exclusion check must set `iterState.status = "failed"` BEFORE the status reset line runs.

**Why it happens:** The Phase 22 comment explicitly notes this: "IMPORTANT: Reset status back to loop-iterating for next iteration" at line 684.

**How to avoid:** Apply exclusion violation failure to `iterState` (the freshly-read nodeStates), then read it for `iterStatus` computation AFTER the violation check. Since `iterStatus` is computed from `iterState.status`, setting `iterState.status = "failed"` before computing `iterStatus` means the exclusion violation propagates correctly to `iterRecord.status`.

**Exact insertion point:**
```
await this.executeNode(iterationNode)
↓ exclusion check here — modifies iterState if violated
↓ read iterState.status for iterStatus
↓ state.status = "loop-iterating"  // reset
```

### Pitfall 3: `git diff --name-only HEAD` shows staged and unstaged changes
**What goes wrong:** `git diff --name-only HEAD` shows all changes from HEAD (both staged and working tree). This is correct for detecting what the fix agent wrote. However, if the agent commits changes to a branch (git output mode), HEAD advances and the diff would be empty.

**Why it happens:** Pipeline nodes in git output mode create a new branch and commit changes. The fix agent's changes are committed before `executeNode` returns.

**How to avoid:** When the node uses git output mode, the committed changes are in the output branch — the local HEAD is still the original. For files output mode, changes are in the container workspace (not the host repo). The exclusion enforcement is meaningful only when the pipeline is running against a host repo directly. Enforce only when `repoPath` is set AND the result has no git-mode output branch (i.e., the agent touched files in the host repo).

**Safer approach:** Check `git status --porcelain` for untracked/modified files, or use `git diff --name-only HEAD` only when node output mode is `files`. Alternatively, check `git diff --name-only HEAD` which will show nothing if changes are committed — this may mean exclusion enforcement is silently skipped in git-mode, which is acceptable since git-mode creates isolated branches anyway.

**Practical resolution:** The CONTEXT.md decision says "Post-execution git diff check after each fix agent iteration" — interpret this as best-effort. If `repoPath` exists, run the check. If git diff returns empty (because agent committed), the check passes silently. The test fixture for CORR-02 should use a pipeline that writes files to a host repo (files output mode or direct repo modification).

### Pitfall 4: `_coverage` variable in non-coverage pipelines
**What goes wrong:** If `_coverage` is injected into the filtrex context for all loop runs but is `-1` for a `_status == "completed"` pipeline, users might accidentally use `_coverage` in expressions and get unexpected `-1` comparisons.

**Why it happens:** `-1` is a sentinel that won't accidentally satisfy `_coverage >= 80` but is confusing in expressions like `_coverage >= 0` which would be false.

**How to avoid:** Always inject `_coverage: -1` when no coverage found, as locked in CONTEXT.md. Document the sentinel clearly in WORKFLOW.md examples.

### Pitfall 5: `loadConfig()` called inside `executeLoopNode` is expensive
**What goes wrong:** `loadConfig()` reads and parses the config file. Called once per iteration for exclusion checking inside a 10-iteration loop = 10 config loads.

**Why it happens:** `executeNode` calls `loadConfig()` internally, but `executeLoopNode` needs the `repo.exclude` list before calling `executeNode`.

**How to avoid:** Call `loadConfig()` once at the top of `executeLoopNode`, cache as `const config = loadConfig()`. Pass `exclude: config.repo.exclude` to the exclusion check. This is the same pattern `executeNode` already uses (each call to `executeNode` calls `loadConfig()` once anyway — two calls per iteration is acceptable).

## Code Examples

Verified patterns from existing codebase:

### SHA-256 Hash Pattern (from src/utils/hash.ts + node:crypto)
```typescript
// Source: src/utils/hash.ts (verified)
import { createHash } from "node:crypto";

// Hash a string for comparison
const hash = createHash("sha256").update(someString).digest("hex");
```

### picomatch Usage Pattern (from src/container/workspace.ts)
```typescript
// Source: src/container/workspace.ts (verified)
import picomatch from "picomatch";

const isExcluded = picomatch(exclude);  // exclude is string[]
const matches = changedFiles.filter(f => isExcluded(f));
```

### execSync Git Pattern (from src/pipeline/executor.ts)
```typescript
// Source: src/pipeline/executor.ts getConflictFiles() (verified)
import { execSync } from "node:child_process";

const output = execSync("git diff --name-only HEAD", {
  cwd: repoPath,
  encoding: "utf-8",
}).trim();
const files = output ? output.split("\n").filter(Boolean) : [];
```

### filtrex Context Extension Pattern (from src/pipeline/executor.ts lines 720-726)
```typescript
// Source: src/pipeline/executor.ts executeLoopNode() (verified)
const untilCtx = {
  ...upstreamCtx,
  _status: iterStatus,
  _iteration: i,
  _max_iterations: maxIterations,
  _first_iteration: i === 1 ? 1 : 0,
  // Add _coverage here:
  _coverage: coverage,  // number, -1 when not found
} as unknown as Parameters<typeof evaluateCondition>[1];
```

### Loop Exhaustion Error Pattern (from src/pipeline/executor.ts line 751)
```typescript
// Source: src/pipeline/executor.ts executeLoopNode() (verified)
state.status = "failed";
state.error = `Loop "${node.id}" exhausted max_iterations (${maxIterations}) without "until" expression becoming true`;
```

### ValidationResult Structure (from src/validation/runner.ts, verified)
Current `ValidationResult` fields: `passed`, `totalAttempts`, `stepResults[]{name, passed, attempts}`.
**Does NOT include stdout** — must add `lastOutput?: string` to expose test output.

### iterState Access Pattern (from src/pipeline/executor.ts lines 679-695, verified)
```typescript
// After executeNode:
const iterState = this.nodeStates.get(node.id)!;
const iterStatus: "completed" | "failed" = iterState.status === "completed" ? "completed" : "failed";
// ...
state.status = "loop-iterating";  // reset happens here — AFTER iterStatus is captured
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No loop support | Loop nodes with until expression + progressive context | Phase 22 | Foundation for all self-correction patterns |
| ValidationResult drops stdout | ValidationResult.lastOutput surfaces test stdout | Phase 24 (this phase) | Enables hash comparison and coverage parsing |

**Already implemented (no work needed):**
- CORR-03: Progressive context — `progressiveContext[]` array in `executeLoopNode` already accumulates iteration output files
- CORR-01: Test-fail/fix/retest pattern — any user can write a YAML pipeline using `loop.until: '_status == "completed"'` today

## Open Questions

1. **Git diff check when agent uses git output mode**
   - What we know: In git output mode, fix agent commits changes to a branch; the host repo HEAD doesn't change; `git diff HEAD` would be empty
   - What's unclear: Whether exclusion enforcement is even meaningful for git-output-mode fix agents (they create isolated branches, test files in that branch are isolated)
   - Recommendation: Scope exclusion check to file-output-mode nodes only, or document that git-mode loops bypass exclude enforcement (it's a no-op because the host repo is untouched)

2. **Coverage: total vs per-file vs statements vs lines**
   - What we know: Different test runners report different metrics; vitest reports per-file tables plus summary; the CONTEXT.md says "common coverage patterns"
   - What's unclear: Which coverage metric to use when multiple are present (statements vs lines vs branches)
   - Recommendation: Use "All files | Lines" for vitest (the summary row), "Lines :" for istanbul/c8, "Statements :" as fallback for jest — this gives the overall project coverage, not per-file

3. **`lastOutput` capture: all steps vs final step vs failing step**
   - What we know: CORR-05 needs stdout+stderr from the test command; a pipeline may have multiple validation steps
   - What's unclear: Which step's output to capture for no-progress detection — test step specifically, or all steps concatenated
   - Recommendation: Concatenate all validation step stdout+stderr in order (all steps from the final pass). The test command output will be present somewhere in the concatenated string; coverage regex will find it regardless of position.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (existing, all tests use vitest) |
| Config file | `vitest.config.ts` (or package.json vitest field) |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npm test -- --reporter=verbose test/unit/pipeline-self-correction.test.ts` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CORR-01 | Test-fail → fix → retest loop runs end-to-end | unit (via PipelineExecutor mock) | `npm test -- test/unit/pipeline-self-correction.test.ts` | Wave 0 |
| CORR-02 | Excluded file modification fails iteration and reverts file | unit (mock execSync) | `npm test -- test/unit/pipeline-self-correction.test.ts` | Wave 0 |
| CORR-03 | Each iteration prompt includes all prior iteration outputs | unit (already tested in pipeline-loop.test.ts) | `npm test -- test/unit/pipeline-loop.test.ts` | exists |
| CORR-04 | `_coverage` extracted from test output, loop exits when threshold met | unit (mock ValidationResult) | `npm test -- test/unit/pipeline-self-correction.test.ts` | Wave 0 |
| CORR-05 | Identical consecutive test outputs abort loop with no-progress error | unit (mock executeRun returning same output) | `npm test -- test/unit/pipeline-self-correction.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/pipeline-self-correction.test.ts test/unit/pipeline-loop.test.ts test/unit/pipeline-executor.test.ts`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/pipeline-self-correction.test.ts` — covers CORR-01, CORR-02, CORR-04, CORR-05
- [ ] `src/validation/runner.ts` — needs `lastOutput?: string` added to `ValidationResult` interface and population in `runValidationLoop`

*(CORR-03 is already covered by `test/unit/pipeline-loop.test.ts` progressive context test — no gap)*

## Sources

### Primary (HIGH confidence)
- `src/pipeline/executor.ts` (read in full) — `executeLoopNode` implementation, exact line numbers for insertion points
- `src/orchestration/single.ts` (read in full) — `ExecutionResult` interface, confirmed no stdout field
- `src/validation/runner.ts` (read in full) — `ValidationResult` interface, confirmed no lastOutput field
- `src/validation/step.ts` (read in full) — `StepResult` interface, confirmed stdout+stderr fields exist in inner loop
- `src/pipeline/checkpoint.ts` (read in full) — loop checkpoint structure
- `src/pipeline/condition.ts` (read in full) — filtrex evaluator, untilCtx extension pattern
- `src/container/workspace.ts` (read in full) — picomatch usage pattern
- `src/utils/hash.ts` (read in full) — SHA-256 pattern
- `test/unit/pipeline-loop.test.ts` (read in full) — test patterns, mock structure, CORR-03 already tested
- `test/unit/pipeline-executor.test.ts` (read partial) — test mock structure for PipelineExecutor

### Secondary (MEDIUM confidence)
- `.planning/phases/24-self-correction-integration/24-CONTEXT.md` — locked decisions, implementation specifics
- `.planning/REQUIREMENTS.md` — CORR-01 through CORR-05 definitions

### Tertiary (LOW confidence)
- Coverage regex patterns for vitest/jest/istanbul are based on knowledge of their output formats (not verified against live output in this repo) — low risk since these are stable, well-documented formats

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries are already in-tree, verified by reading source files
- Architecture: HIGH — integration points verified by reading exact line numbers in executor.ts
- Pitfalls: HIGH — identified by reading Phase 22 commit decisions and the actual code patterns
- Coverage regex patterns: MEDIUM — based on known test runner formats; may need minor tuning against real vitest output

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (stable domain — no external dependencies changing)
