---
phase: 24-self-correction-integration
verified: 2026-03-13T23:40:00Z
status: gaps_found
score: 5/6 must-haves verified
re_verification: false
gaps:
  - truth: "Fix agent modifying an excluded file causes the iteration to fail with specific file names in error"
    status: partial
    reason: "CORR-02 exclusion enforcement code is wired in executor.ts but the test uses a conditional assertion that accepts either outcome. The vi.doMock for execSync cannot rebind the already-imported static execSync in executor.ts. Since no test pipeline node sets a 'repo' path, the repoPath guard evaluates to undefined and the exclusion check is skipped — the test takes the else branch asserting 'completed' instead of verifying the enforcement path."
    artifacts:
      - path: "test/unit/pipeline-self-correction.test.ts"
        issue: "Lines 239-245 use if/else allowing 'completed' status — the else branch is always taken because repoPath is undefined in test pipelines. The test passes without ever exercising the violation detection path."
      - path: "src/pipeline/executor.ts"
        issue: "CORR-02 code is present and correct (lines 686-719) but requires node.repo / pipeline.defaults.repo / options.repo to be set. Test pipelines define no repo, so the guard at line 688 is never entered."
    missing:
      - "Test pipeline for exclusion enforcement must include a 'repo' field on the loop node, or the makeLoopPipeline helper must accept a repo option"
      - "vi.doMock of node:child_process cannot rebind static imports — replace with a vi.mock at top level or inject execSync via dependency injection, or mock at the module boundary before executor is imported"
      - "The conditional assertion (if/else) must be replaced with a strict assertion that expects 'failed' status and the specific error message"
human_verification: []
---

# Phase 24: Self-Correction Integration Verification Report

**Phase Goal:** Pipelines can autonomously run tests, detect failures, invoke a fix agent with full iteration history, retest, and exhaust cleanly — proving the loop node + context piping composition works end-to-end
**Verified:** 2026-03-13T23:40:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | ValidationResult exposes lastOutput with combined stdout+stderr from final validation pass | VERIFIED | `runner.ts` line 76-86 (pass path) and 111-121 (fail path) — `lastResults` tracked outside while loop, concatenated stdout+stderr of all steps |
| 2 | extractCoverage parses vitest, jest/istanbul, and c8 coverage formats from test output | VERIFIED | `src/pipeline/coverage.ts` — 4 regex patterns (vitest, Statements, Lines, generic), all tested with 6 unit tests passing |
| 3 | extractCoverage returns -1 when no coverage pattern is found | VERIFIED | `coverage.ts` line 24 — `return -1` sentinel verified by 2 tests |
| 4 | Loop aborts immediately with no-progress error when consecutive iterations produce identical test output | VERIFIED | `executor.ts` lines 726-736 — SHA-256 hash comparison; test "aborts loop when consecutive iterations produce identical test output" passes |
| 5 | Fix agent modifying an excluded file causes the iteration to fail with specific file names in error | PARTIAL | Code wired in `executor.ts` lines 686-719; but test never exercises violation path (repoPath is undefined, guard skipped, test takes else branch) |
| 6 | Coverage percentage extracted from test output is available as _coverage in until expression context | VERIFIED | `executor.ts` lines 777-785 — `extractCoverage(lastOutput)` injected as `_coverage` in untilCtx; "exhaustion message includes final coverage" test passes |

**Score:** 5/6 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/validation/runner.ts` | ValidationResult.lastOutput field populated from validation step results | VERIFIED | `lastOutput?: string` field present in interface (line 18); populated in both pass and exhausted-retries return paths via `lastResults` variable |
| `src/pipeline/coverage.ts` | extractCoverage utility function | VERIFIED | 26-line file; exports `extractCoverage(output: string): number`; 4 regex patterns in priority order |
| `test/unit/pipeline-self-correction.test.ts` | Test scaffold for CORR-01, CORR-02, CORR-04, CORR-05 | PARTIAL | 385 lines, 15 tests all passing; but CORR-02 exclusion test has conditional assertion that accepts either pass/fail — enforcement path never exercised |
| `src/pipeline/executor.ts` | No-progress detection, exclusion enforcement, coverage injection in executeLoopNode | VERIFIED | All three features wired; `createHash`, `picomatch`, `extractCoverage` imported; CORR-02/04/05 comments present at insertion points |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/validation/runner.ts` | `src/orchestration/single.ts` | ValidationResult type flows through ExecutionResult.validation | VERIFIED | `single.ts` imports `ValidationResult` type (line 4), imports `runValidationLoop` (line 18), assigns `validation: validationResult` in all return paths |
| `src/pipeline/executor.ts` | `src/pipeline/coverage.ts` | import extractCoverage | VERIFIED | `executor.ts` line 29: `import { extractCoverage } from "./coverage.js"` |
| `src/pipeline/executor.ts` | `src/validation/runner.ts` | reads iterState.result.validation.lastOutput | VERIFIED | `executor.ts` lines 727, 778 both read `iterState.result?.validation?.lastOutput` |
| `src/pipeline/executor.ts` | `picomatch` | import picomatch for exclude glob matching | VERIFIED | `executor.ts` line 3: `import picomatch from "picomatch"` |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| CORR-01 | 24-01 | Test-fail → fix → retest pipeline pattern using loop nodes with failure output as context | VERIFIED | Loop node infrastructure from Phase 22 with progressive context (`executor.ts` lines 644-665, 754-765); each iteration writes output file appended to next iteration's context |
| CORR-02 | 24-02 | Fix agent excluded from modifying test files via WORKFLOW.md exclude list | PARTIAL | Code wired in `executor.ts` 686-719; test does not verify enforcement path (see gap) |
| CORR-03 | 24-01 | Each fix iteration includes history of all previous attempts (progressive context) | VERIFIED | `progressiveContext` array built across iterations; iteration output files written and appended to each subsequent node clone's context (lines 677-681) |
| CORR-04 | 24-01, 24-02 | Coverage self-correction: loop until coverage >= threshold with structured output parsing | VERIFIED | `extractCoverage` utility + `_coverage` injected into untilCtx; exhaustion message includes `final coverage: X.X%` |
| CORR-05 | 24-01, 24-02 | Clean exhaustion failure when max_iterations reached | VERIFIED | No-progress detection aborts with "no progress detected" error; exhaustion path includes coverage-aware message; "exhaustion message includes final coverage" test passes |

All 5 CORR requirement IDs from REQUIREMENTS.md are accounted for across the two plans. No orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `test/unit/pipeline-self-correction.test.ts` | 239-245 | Conditional assertion (`if/else`) where both branches pass regardless of enforcement | Warning | CORR-02 enforcement not actually tested end-to-end |
| `test/unit/pipeline-self-correction.test.ts` | 262-266 | `expect(true).toBe(true)` placeholder for "reverts excluded files via git checkout" | Warning | CORR-02 revert behavior (git checkout) never asserted |

No blockers in implementation files. No TODO/FIXME/placeholder comments in `src/` files.

### Human Verification Required

None. All behavioral claims are verifiable programmatically.

### Gaps Summary

**One gap blocking full goal verification: CORR-02 exclusion enforcement test coverage.**

The code implementing CORR-02 exclusion enforcement is present and correctly structured in `executor.ts` (lines 686-719). The logic reads `node.repo ?? pipeline.defaults?.repo ?? options.repo` to determine the repo path, then runs `git diff --name-only HEAD`, matches changed files against `repo.exclude` globs via picomatch, reverts violations, and marks the node failed.

However, the test that should verify this behavior (`"fails iteration when fix agent modifies excluded file"`) never exercises it because:

1. The loop node in the test pipeline has no `repo` field, so `repoPath` evaluates to undefined at line 687 and the entire exclusion check block is skipped.
2. The `vi.doMock("node:child_process", ...)` call cannot rebind `execSync` after `executor.ts` has already been imported via a top-level `await import()` — the static binding is already resolved.
3. The test assertion is conditional: if status is "failed" it checks the error message; if "completed" it accepts that too. The test always passes because the loop completes successfully.

A related placeholder test (`"reverts excluded files via git checkout when violated"`) contains `expect(true).toBe(true)` — it always passes unconditionally.

**Fix required:** Either (a) pass a `repo` path pointing to a real git repo in the test pipeline definition and restructure the `execSync` mock to work before the executor module loads, or (b) extract the exclusion check into a testable helper function that can be directly tested with mocked `execSync`, or (c) use `vi.spyOn(childProcess, "execSync")` with a top-level module mock established before executor imports.

The phase goal states pipelines can "detect failures, invoke a fix agent with full iteration history, retest, and exhaust cleanly." The failure-detection path for test file exclusion is implemented but lacks a passing test that proves it works. The other four behaviors (run-test loop, progressive context, coverage injection, no-progress detection) are verified.

---

_Verified: 2026-03-13T23:40:00Z_
_Verifier: Claude (gsd-verifier)_
