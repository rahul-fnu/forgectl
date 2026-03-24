# Reactive Maintenance Plan — CI Failure Dispatch, Test Generation, Triage, Reproduce-First

*Inspired by Ramp's agentic maintenance system. Adapted for forgectl's architecture.*

---

## Overview

Four features that transform forgectl from a batch issue processor into a reactive maintenance engine:

1. **CI Failure Dispatch** — auto-fix broken builds by dispatching agents when CI fails
2. **Post-Merge Test Generation** — identify test coverage gaps after PRs merge, auto-create issues
3. **Triage Gate** — fast pre-dispatch filtering to avoid wasting agent time on bad issues
4. **Reproduce-First Prompting** — make agents prove the bug exists before fixing it

## Architecture

```
                    ┌─────────────────────────────┐
   GitHub Webhook   │  CI check_run.completed      │
   (new)            │  → extract failure logs       │
                    │  → create synthetic issue     │
                    │  → onDispatch()               │
                    └──────────┬──────────────────┘
                               │
   Linear Poll     ┌───────────▼──────────────────┐
   (existing)      │  Scheduler Tick                │
                   │  → fetchCandidateIssues()      │
                   │  → filterCandidates()          │
                   └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │  Triage Gate (new)            │
                    │  → fast LLM: should we work? │
                    │  → duplicate detection        │
                    │  → complexity estimate        │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │  Governance Gate (existing)   │
                    │  → autonomy level check       │
                    │  → auto-approve rules         │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │  Agent Execution              │
                    │  → reproduce first (new)      │
                    │  → fix the issue              │
                    │  → validation loop             │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │  PR → Review → Merge          │
                    │  → post-merge test gen (new)  │
                    └──────────────────────────────┘
```

---

## Feature 1: CI Failure Webhook Dispatch

### What
When a GitHub Actions check run fails on a `forge/*` branch, auto-dispatch an agent with the failure logs to fix it.

### Where it fits
- **Webhook handler:** `src/github/webhooks.ts` — add `check_suite.completed` handler (lines 82-202, follows existing pattern)
- **CI log fetching:** `src/merge-daemon/pr-processor.ts` `fetchCIErrorLog()` (lines 997-1070) — extract to shared utility
- **Dispatch:** Uses existing `deps.onDispatch()` callback (line 16 of webhooks.ts)
- **Server wiring:** `src/daemon/server.ts` lines 212-243 — already registers webhook handlers

### Implementation

```typescript
// src/github/webhooks.ts — new handler
app.webhooks.on("check_suite.completed", async ({ payload, octokit }) => {
  if (payload.check_suite.conclusion !== "failure") return;
  if (!payload.check_suite.head_branch?.startsWith("forge/")) return;

  const logs = await fetchCIErrorLog(payload, octokit);
  const issue: TrackerIssue = {
    id: `ci-fix-${payload.check_suite.id}`,
    identifier: `CI-FIX-${payload.check_suite.head_branch}`,
    title: `Fix CI failure on ${payload.check_suite.head_branch}`,
    description: `CI failed. Error logs:\n\n${logs}`,
    // ... standard fields
  };
  deps.onDispatch(issue, octokit, repoContext);
});
```

### Also: Generic dispatch endpoint

```typescript
// src/daemon/routes.ts — new endpoint
app.post("/api/v1/dispatch", async (request, reply) => {
  const { title, description, repo, context } = request.body;
  // Create synthetic TrackerIssue, dispatch through orchestrator
});
```

### Effort: 1-2 phases

---

## Feature 2: Post-Merge Test Generation

### What
After a PR merges, analyze the changed files against the KG test mappings. If any changed source files lack test coverage, auto-create a Linear issue.

### Where it fits
- **Post-merge hook:** `src/merge-daemon/pr-processor.ts` after line 435 (merge success)
- **Test mapping:** `src/kg/test-mapping.ts` `buildTestMappings()` (lines 12-68)
- **Coverage parsing:** `src/pipeline/coverage.ts` `extractCoverage()` (lines 7-25)
- **Issue creation:** `src/tracker/types.ts` `TrackerAdapter.createIssue()` (if exists) or direct Linear API

### Implementation

```typescript
// src/merge-daemon/pr-processor.ts — after merge success
async postMergeAnalysis(pr: PRInfo, tmpDir: string): Promise<void> {
  // 1. Get changed files from the merged diff
  const changedFiles = execSync("git diff --name-only HEAD~1", { cwd: tmpDir }).trim().split("\n");

  // 2. Build test mappings for the workspace
  const kgDb = createKGDatabase(join(tmpDir, "kg.db"));
  const mappings = getTestMappings(kgDb);

  // 3. Find uncovered source files
  const gaps = changedFiles.filter(f =>
    f.endsWith(".ts") && !f.includes("test") &&
    !mappings.some(m => m.sourceFile === f)
  );

  // 4. Create issue for each gap (or batch)
  if (gaps.length > 0) {
    await tracker.createIssue({
      title: `Add tests for ${gaps.length} uncovered file(s) from PR #${pr.number}`,
      description: `Files changed without test coverage:\n${gaps.map(f => `- ${f}`).join("\n")}`,
    });
  }
}
```

### Effort: 1 phase

---

## Feature 3: Triage Gate

### What
Before dispatching an issue, run a fast LLM evaluation: Is this a duplicate? Can the agent handle it? What's the complexity?

### Where it fits
- **Insertion point:** `src/orchestrator/dispatcher.ts` line 340 — before `executeWorkerAndHandle()`
- **Similar pattern:** `src/governance/autonomy.ts` `needsPreApproval()` (lines 7-9)
- **Config:** `src/config/schema.ts` `OrchestratorConfigSchema` (lines 89-100)

### Implementation

```typescript
// src/orchestrator/triage.ts
export interface TriageResult {
  shouldDispatch: boolean;
  reason: string;
  complexity: "low" | "medium" | "high";
  duplicateOf?: string;
}

export async function triageIssue(
  issue: TrackerIssue,
  state: OrchestratorState,
  config: ForgectlConfig,
): Promise<TriageResult> {
  // 1. Check for duplicate by title/description similarity against running issues
  for (const [id, worker] of state.running) {
    if (worker.issue.title === issue.title) {
      return { shouldDispatch: false, reason: "Duplicate of running issue", complexity: "low" };
    }
  }

  // 2. Fast LLM call for complexity assessment
  const prompt = `Issue: ${issue.title}\n${issue.description}\n\nCan an AI coding agent fix this? Reply JSON: {"dispatch": true/false, "reason": "...", "complexity": "low|medium|high"}`;
  // Use fast model, 2s timeout
  const result = await quickLLMCall(prompt, { timeout: 2000 });
  return parseTriageResult(result);
}
```

### Effort: 1 phase

---

## Feature 4: Reproduce-First Prompting

### What
When an issue contains error logs or a bug report, instruct the agent to reproduce the failure first, then fix it.

### Where it fits
- **Schema:** `src/config/schema.ts` `ValidationStepSchema` (lines 32-38) — add `expect_failure` and `before_fix` fields
- **Step runner:** `src/validation/step.ts` `runValidationStep()` (lines 18-39) — invert pass/fail
- **Prompt:** `src/context/prompt.ts` `buildPrompt()` (lines 114-120) — mark reproduction steps

### Implementation

```typescript
// src/config/schema.ts — extend ValidationStepSchema
export const ValidationStepSchema = z.object({
  name: z.string(),
  command: z.string(),
  retries: z.number().int().min(0).default(3),
  timeout: duration.optional(),
  description: z.string().default(""),
  expect_failure: z.boolean().default(false),  // inverts pass/fail
  before_fix: z.boolean().default(false),      // marks as reproduction step
});

// src/validation/step.ts — invert when expected
if (step.expect_failure) {
  result.passed = result.exitCode !== 0; // success when command fails
}

// src/context/prompt.ts — guide agent
parts.push("First reproduce the bug, then fix it:");
for (const step of reproductionSteps) {
  parts.push(`🔴 REPRODUCE: ${step.command} — should FAIL before your fix`);
}
for (const step of verificationSteps) {
  parts.push(`✅ VERIFY: ${step.command} — should PASS after your fix`);
}
```

### Effort: 1 phase (mostly prompt + schema changes)

---

## Build Order

```
Phase 1: CI Failure Dispatch + Generic /api/v1/dispatch endpoint
Phase 2: Reproduce-First Prompting (low effort, immediate quality improvement)
Phase 3: Post-Merge Test Generation
Phase 4: Triage Gate
```

CI failure dispatch first because it's the highest-leverage reactive capability. Reproduce-first second because it's low effort and immediately improves fix quality for CI-triggered issues. Post-merge test generation third — closes the quality feedback loop. Triage last — becomes important when dispatch volume increases.

---

## Integration Notes

- **All 4 features are additive** — none require changing existing behavior, only extending it
- **Shared utility:** Extract `fetchCIErrorLog()` from merge daemon to `src/github/ci-logs.ts` (used by both CI dispatch and reproduce-first)
- **Config additions:** All configurable via existing schema extension pattern
- **Storage:** Test gaps and triage verdicts use existing SQLite repository pattern
- **The existing webhook → dispatch → agent → validation → PR → review → merge pipeline doesn't change** — these features plug into entry points (CI webhook), pre-dispatch (triage), execution (reproduce), and post-merge (test gen)

---

*Plan created 2026-03-24. Derived from Ramp's agentic maintenance blog post, adapted for forgectl's architecture.*
