# Phase 27: Agent Teams - Research

**Researched:** 2026-03-13
**Domain:** TypeScript — orchestrator slot management, container resource scaling, config schema extension, checkpoint bypass
**Confidence:** HIGH

## Summary

Phase 27 adds Claude Code agent team support to forgectl. The design is deliberately minimal: forgectl's job is to set a single env var (`CLAUDE_NUM_TEAMMATES=N`) inside the container, and Claude Code handles all teammate coordination internally. Three independent subsystems need changes: (1) the Zod schema + WorkflowFrontMatterSchema + WorkflowFileConfig + RunPlan to carry team config, (2) the resolver to compute scaled memory and set `skipCheckpoints`, (3) the SlotManager to sum slot weights rather than count running workers.

The implementation follows two established Phase 26 patterns closely: the `--no-skills` flag (Commander boolean negation → `noSkills` on RunPlan) is the template for `--no-team`, and the `skills` field addition to WorkflowFrontMatterSchema / WorkflowFileConfig / WorkflowSchema is the template for the `team` section. Crash recovery is already "mark as interrupted" — no active resume logic exists, so team runs get the same treatment without additional code.

**Primary recommendation:** Follow the `--no-skills` / `noSkills` pattern from Phase 26 exactly. Six touch points, each small.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Team Activation Mechanism**
- Activate team mode via `CLAUDE_NUM_TEAMMATES=N` env var set on the container
- Single env var only — no role hints, no prompt wrapping, no CLI flags to Claude Code
- Add `--no-team` CLI flag to disable team mode for a specific run (mirrors `--no-skills` pattern from Phase 26)
- Claude Code only — if team config is present but agent type isn't claude-code, log a warning and run without team mode (non-breaking)
- Env var added to `agentEnv` array in `prepareExecution()`, same pattern as `ANTHROPIC_API_KEY` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`

**Workflow Config Shape**
- Minimal config: `team: { size: 3 }` — size only, no roles or coordination mode
- Team size capped at 5 in Zod schema: `z.number().int().min(2).max(5)`
- `--team-size N` CLI flag overrides workflow definition (follows 4-layer merge: defaults → forgectl.yaml → WORKFLOW.md → CLI flags)
- Agent type mismatch (team + non-claude-code): warn and ignore, don't error

**Resource Scaling**
- Memory scales: final memory = base + (teammates * 1GB), computed in resolver before RunPlan
- CPU does NOT scale — teammates are I/O-bound (API calls), not CPU-bound
- `createContainer()` stays unchanged — it just reads the already-computed `plan.container.resources.memory`
- Resolver writes the scaled memory value directly into RunPlan

**Slot Weight Accounting**
- All runs get a weight: 1 for solo, team size for teams (uniform model)
- `SlotManager.availableSlots()` sums weights across running workers instead of counting `running.size`
- A 3-person team occupies 3 slots, preventing OOM from concurrent team runs
- Non-team runs are implicitly weight=1, so existing behavior is preserved

**Checkpoint Bypass**
- Add `skipCheckpoints: boolean` field to RunPlan
- Resolver sets `skipCheckpoints = true` when team config has size > 1
- The 3 `saveCheckpoint()` calls in `executeSingleAgent()` check `!plan.skipCheckpoints` before saving
- On failure: restart from scratch (existing retry queue re-enqueues, no checkpoint to resume from)
- On crash recovery (daemon restart): re-enqueue team runs for fresh start, don't attempt resume

### Claude's Discretion
- Exact Zod schema structure for the `team` section in WorkflowSchema
- How `--no-team` flows through resolver (same pattern as `--no-skills` / `noSkills`)
- WorkerInfo changes needed to carry slot weight
- Whether to add team size to run event metadata for observability

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| TEAM-01 | Enable Claude Code agent teams via env vars and prompt wrapping inside containers | `CLAUDE_NUM_TEAMMATES=N` in `agentEnv` inside `prepareExecution()` claude-code branch; warn+skip for non-claude-code |
| TEAM-02 | Auto-scale container memory by team size (base + 1GB per teammate) | Resolver reads base memory string, calls `parseMemory()` equivalent math, writes scaled string to `plan.container.resources.memory` |
| TEAM-03 | Update slot manager to weight concurrent slots by team size, not run count | `WorkerInfo` gains `slotWeight: number`; `SlotManager.availableSlots()` sums weights instead of `running.size` |
| TEAM-04 | Disable checkpoint/resume for team runs (incompatible with team internal state) | `RunPlan.skipCheckpoints: boolean`; gate all 4 `saveCheckpoint()` calls in `executeSingleAgent()` on `!plan.skipCheckpoints` |
| TEAM-05 | Support `team:` section in WORKFLOW.md for team size, roles, and coordination mode | Extend `WorkflowFrontMatterSchema`, `WorkflowFileConfig`, `WorkflowSchema`, and `RunPlan` with `team?: { size: number }` |
</phase_requirements>

## Standard Stack

### Core (all already installed — zero new dependencies)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | already in use | Schema validation for `team` section | Same as `skills` addition in Phase 26 |
| dockerode | already in use | Container creation reads `plan.container.resources.memory` | `createContainer()` already uses `parseMemory()` |
| commander | already in use | `--no-team` and `--team-size N` CLI flags | Same as `--no-skills` / `--no-review` pattern |

No new `npm install` needed. All v3.0 requirements state "zero new npm dependencies."

## Architecture Patterns

### Recommended Project Structure (additions only)
```
src/
├── config/schema.ts          # Add WorkflowSchema `team` field
├── workflow/
│   ├── types.ts              # RunPlan.skipCheckpoints + RunPlan.team; WorkflowFileConfig.team
│   ├── workflow-file.ts      # WorkflowFrontMatterSchema: add team section
│   └── resolver.ts           # Team memory scaling + skipCheckpoints + noTeam
├── orchestrator/
│   └── state.ts              # WorkerInfo.slotWeight + SlotManager weight-sum logic
├── orchestration/
│   └── single.ts             # CLAUDE_NUM_TEAMMATES env var + skipCheckpoints gates
└── index.ts                  # --no-team + --team-size CLI flags
```

### Pattern 1: Commander boolean negation (from Phase 26 --no-skills)

**What:** Commander `.option("--no-X")` automatically sets `opts.X = false` when passed. No explicit `false` value is needed in the option definition.

**When to use:** Any CLI flag that disables an optional feature already controlled by workflow config.

```typescript
// src/index.ts — add alongside --no-skills
.option("--no-team", "Disable agent team mode for this run")
.option("--team-size <n>", "Override team size (2-5)", parseInt)
```

```typescript
// src/workflow/resolver.ts CLIOptions — follow noSkills pattern exactly
export interface CLIOptions {
  // existing fields...
  skills?: boolean;   // false when --no-skills passed
  team?: boolean;     // false when --no-team passed  (Claude's discretion: naming)
  teamSize?: number;  // numeric override from --team-size
}
```

```typescript
// resolver.ts resolveRunPlan() — mirror noSkills assignment
noTeam: options.team === false,
```

### Pattern 2: Zod schema extension (from Phase 26 skills)

**What:** Add optional field to WorkflowSchema (for built-in workflow config) and WorkflowFrontMatterSchema (for WORKFLOW.md parsing). Must keep `.strict()` on WorkflowFrontMatterSchema or ZodError will fire on unknown keys.

**When to use:** Any new per-workflow configuration field.

```typescript
// src/config/schema.ts — WorkflowSchema addition (Claude's discretion: exact shape)
team: z.object({
  size: z.number().int().min(2).max(5),
}).optional(),
```

```typescript
// src/workflow/workflow-file.ts — WorkflowFrontMatterSchema (inside .object({...}).strict())
team: z.object({
  size: z.number().int().min(2).max(5),
}).optional(),
```

```typescript
// src/workflow/types.ts — WorkflowFileConfig interface
team?: {
  size?: number;
};
```

### Pattern 3: RunPlan field addition

**What:** Add optional fields to RunPlan for backward compatibility. Existing code that doesn't set the field gets `undefined`, which is falsy.

```typescript
// src/workflow/types.ts RunPlan
noSkills?: boolean;       // Phase 26 (already present)
noTeam?: boolean;         // Phase 27 — disable team mode for this run
skipCheckpoints?: boolean; // Phase 27 — team runs skip checkpoint saves
team?: {
  size: number;
  slotWeight: number;     // computed: equals size (uniform model)
};
```

### Pattern 4: SlotManager weight-aware accounting

**What:** `WorkerInfo` gains `slotWeight: number` (1 for solo, teamSize for teams). `SlotManager.availableSlots()` sums weights across the running map instead of using `running.size`.

**When to use:** Any scenario where a single worker should consume multiple logical concurrency slots.

```typescript
// src/orchestrator/state.ts
export interface WorkerInfo {
  // existing fields...
  slotWeight: number;  // 1 for solo runs, team.size for team runs
}

// SlotManager.availableSlots becomes:
availableSlots(running: Map<string, WorkerInfo>): number {
  const usedWeight = [...running.values()].reduce((sum, w) => sum + w.slotWeight, 0);
  return Math.max(0, this.maxConcurrent - usedWeight);
}
```

**Backward compatibility:** All existing callers that add to `running` must set `slotWeight: 1`. This is one call site in `src/orchestrator/worker.ts` (to confirm during implementation).

### Pattern 5: Memory scaling in resolver

**What:** `parseMemory()` lives in `src/container/runner.ts` but is not exported. The resolver needs to parse the base memory string, add teammates * 1GB, and produce a new memory string. Options: (a) duplicate the parsing logic inline, (b) export `parseMemory()`, (c) inline the arithmetic using a local helper.

**Recommended:** Export `parseMemory()` from `runner.ts` and use it in the resolver — avoids duplication without adding complexity.

```typescript
// resolver.ts memory scaling
function scaleMemoryForTeam(baseMemory: string, teammateCount: number): string {
  const baseBytes = parseMemory(baseMemory);         // imported from runner.ts
  const extraBytes = teammateCount * 1024 ** 3;      // 1GB per teammate
  const totalGB = Math.ceil((baseBytes + extraBytes) / 1024 ** 3);
  return `${totalGB}g`;
}
// teammate count = team.size - 1 (lead agent is not a teammate)
```

### Pattern 6: Checkpoint bypass gates

**What:** `executeSingleAgent()` has exactly 4 `saveCheckpoint()` calls (lines 214, 236, 245, 253). All must be wrapped with `if (!plan.skipCheckpoints)`.

```typescript
// src/orchestration/single.ts — apply to all 4 save sites
if (snapshotRepo && !plan.skipCheckpoints) saveCheckpoint(snapshotRepo, plan.runId, "prepare");
```

### Anti-Patterns to Avoid

- **Exporting parseMemory without a test:** If parseMemory is exported, add a unit test case for the scaling math to prevent regressions.
- **Forgetting to set slotWeight on existing WorkerInfo construction sites:** A `slotWeight` field on `WorkerInfo` without updating callers causes TypeScript compile errors (`noUnusedLocals` catches unused but not missing required fields if optional).
- **Making slotWeight optional on WorkerInfo:** Making it optional would require null-checks everywhere. Default it to 1 in the one worker construction call site instead.
- **Setting skipCheckpoints as `undefined` vs `false`:** Both are falsy, but the existing `if (snapshotRepo) saveCheckpoint(...)` pattern needs to be `if (snapshotRepo && !plan.skipCheckpoints) saveCheckpoint(...)`. Don't replace the snapshotRepo check.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Memory string math | Custom regex parsing | Export `parseMemory()` from `runner.ts` | Already handles `g`/`m` suffixes with a default fallback |
| CLI boolean negation | Manual `--no-team true/false` option | Commander `.option("--no-team")` | Built-in Commander behavior: `--no-X` sets `opts.X = false` automatically |
| Team config validation | Manual size checks in resolver | Zod `z.number().int().min(2).max(5)` | Validation happens at schema parse time, not at runtime |
| Slot weight iteration | Separate slot weight map | `slotWeight` field on `WorkerInfo` | Weight already lives with the worker, no synchronization needed |

## Common Pitfalls

### Pitfall 1: WorkflowFrontMatterSchema .strict() rejection
**What goes wrong:** Adding `team` to `WorkflowFileConfig` TypeScript type but forgetting to add it to `WorkflowFrontMatterSchema` causes runtime `ZodError: Unrecognized key(s) in object: 'team'` when WORKFLOW.md contains a `team:` section.
**Why it happens:** `WorkflowFrontMatterSchema` uses `.strict()` (line 99 of workflow-file.ts), which rejects any key not declared in the schema.
**How to avoid:** Add the `team` field to `WorkflowFrontMatterSchema` in `workflow-file.ts` AND to `WorkflowSchema` in `config/schema.ts` in the same plan.
**Warning signs:** Tests for WORKFLOW.md parsing with `team:` front matter throw ZodError.

### Pitfall 2: Existing SlotManager test breakage
**What goes wrong:** The existing `orchestrator-state.test.ts` tests construct `{} as WorkerInfo` for the running map. After adding required `slotWeight` field, TypeScript's `as WorkerInfo` cast still compiles, but `slotWeight` is `undefined`, causing weight summation to return `NaN` instead of a number.
**Why it happens:** `[...running.values()].reduce((sum, w) => sum + w.slotWeight, 0)` returns `NaN` when `w.slotWeight` is `undefined`.
**How to avoid:** Update all test fixtures that use `{} as WorkerInfo` to include `slotWeight: 1`. Make `slotWeight` required (not optional) on the interface to get compile-time errors.
**Warning signs:** `availableSlots` returns `NaN` in tests.

### Pitfall 3: Memory scaling produces non-integer GB string
**What goes wrong:** Base memory like `"4g"` + 2GB teammates = `6g` works cleanly. But if base memory is `"4096m"` (megabytes), the math must handle the conversion.
**Why it happens:** `parseMemory("4096m")` returns bytes correctly, but the scaled result must be converted back to a `g`-suffixed string.
**How to avoid:** Always output scaled memory as whole-number GB (`${totalGB}g`). `Math.ceil` handles any fractional rounding.
**Warning signs:** Docker rejects memory string or container starts with wrong limit.

### Pitfall 4: noTeam flag not propagated to WorkerInfo slotWeight
**What goes wrong:** User passes `--no-team`, resolver sets `noTeam: true` on RunPlan, but the worker that constructs `WorkerInfo` still reads `plan.team?.size` to set `slotWeight`. If `noTeam` is not checked, a team run with `--no-team` would still count as `N` slots.
**Why it happens:** The resolver correctly skips setting the `CLAUDE_NUM_TEAMMATES` env var when `noTeam` is true, but the slot weight calculation in the worker is independent.
**How to avoid:** In the worker, set `slotWeight = (!plan.noTeam && plan.team?.size) ? plan.team.size : 1`.

### Pitfall 5: Recovery code path needs team awareness
**What goes wrong:** The CONTEXT.md says "On crash recovery: re-enqueue team runs for fresh start, don't attempt resume." The current `recoverInterruptedRuns()` in `src/durability/recovery.ts` marks all interrupted runs as `"interrupted"` — it does NOT re-enqueue. Re-enqueueing is handled by the retry mechanism, not recovery.
**Why it happens:** Misreading the recovery flow. The current implementation marks runs as `"interrupted"` on daemon restart; it doesn't re-enqueue anything. Team runs with `skipCheckpoints: true` and `snapshotRepo` check already skipped saving, so `loadLatestCheckpoint()` returns null and the reason message is "Daemon crashed before any checkpoint was saved" — which is correct.
**How to avoid:** No special recovery code needed. The existing `recoverInterruptedRuns()` already handles team runs correctly because they have no checkpoint to resume from.

## Code Examples

### Env var injection — TEAM-01
```typescript
// src/orchestration/single.ts prepareExecution() — inside the claude-code branch
// after CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC line:
if (plan.agent.type === "claude-code") {
  // ...existing auth/env code...
  agentEnv.push("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");

  // Team mode: set CLAUDE_NUM_TEAMMATES if team configured and not disabled
  if (!plan.noTeam && plan.team && plan.team.size > 1) {
    const teammates = plan.team.size - 1; // teammates = size - lead
    agentEnv.push(`CLAUDE_NUM_TEAMMATES=${teammates}`);
  }
}
```

### Memory scaling — TEAM-02
```typescript
// src/workflow/resolver.ts resolveRunPlan()
// In the container.resources block:
const baseMemory = config.container.resources.memory; // e.g. "4g"
const teamSize = !resolvedNoTeam && workflow.team?.size && workflow.team.size > 1
  ? workflow.team.size
  : 1;
const teammateCount = teamSize - 1;
const scaledMemory = teammateCount > 0
  ? scaleMemoryForTeam(baseMemory, teammateCount)
  : baseMemory;

// helpers (inline or imported):
function scaleMemoryForTeam(base: string, extraAgents: number): string {
  const match = base.match(/^(\d+)(g|m)$/i);
  const baseBytes = match
    ? parseInt(match[1]) * (match[2].toLowerCase() === "g" ? 1024 ** 3 : 1024 ** 2)
    : 4 * 1024 ** 3;
  const totalGB = Math.ceil((baseBytes + extraAgents * 1024 ** 3) / 1024 ** 3);
  return `${totalGB}g`;
}
```

### Slot weight — TEAM-03
```typescript
// src/orchestrator/state.ts WorkerInfo — add one field
export interface WorkerInfo {
  issueId: string;
  identifier: string;
  issue: TrackerIssue;
  session: AgentSession | null;
  cleanup: CleanupContext;
  startedAt: number;
  lastActivityAt: number;
  attempt: number;
  slotWeight: number;  // 1 for solo, team.size for team runs
}

// SlotManager.availableSlots — replace running.size with weight sum
availableSlots(running: Map<string, WorkerInfo>): number {
  const usedWeight = [...running.values()].reduce(
    (sum, w) => sum + w.slotWeight, 0
  );
  return Math.max(0, this.maxConcurrent - usedWeight);
}
```

### Checkpoint bypass — TEAM-04
```typescript
// src/orchestration/single.ts — all 4 saveCheckpoint call sites
// Before: if (snapshotRepo) saveCheckpoint(snapshotRepo, plan.runId, "prepare");
// After:
if (snapshotRepo && !plan.skipCheckpoints) saveCheckpoint(snapshotRepo, plan.runId, "prepare");
```

### RunPlan additions — TEAM-05
```typescript
// src/workflow/types.ts RunPlan — append after noSkills
noTeam?: boolean;
skipCheckpoints?: boolean;
team?: {
  size: number;
  slotWeight: number;
};
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Slot counting by `running.size` | Slot counting by sum of `slotWeight` | Phase 27 | Team runs consume multiple slots; solo runs unaffected |
| No team config | `team: { size }` in WORKFLOW.md | Phase 27 | Enables per-workflow team size |
| Checkpoint saved on all runs | Checkpoint skipped when `skipCheckpoints` | Phase 27 | Team runs restart clean on failure |

## Open Questions

1. **Worker construction call site for slotWeight**
   - What we know: `WorkerInfo` is constructed in `src/orchestrator/worker.ts`
   - What's unclear: Exact line and whether RunPlan is accessible at that point to set `slotWeight`
   - Recommendation: Confirm during implementation; if RunPlan is not available, pass team size as a separate parameter or derive from WorkerInfo post-construction

2. **--team-size CLI flag type coercion**
   - What we know: Commander's `parseInt` callback converts string to number
   - What's unclear: Whether `parseInt` alone is sufficient or a custom validation is needed to enforce min(2)/max(5)
   - Recommendation: Use Commander's `parseInt` for parsing; add a runtime check in `resolveRunPlan()` that logs a warning and clamps to 2-5 range rather than throwing

3. **CLAUDE_NUM_TEAMMATES exact semantics**
   - What we know: CONTEXT.md says "Claude Code handles teammate coordination internally" — this is the design assumption
   - What's unclear: Whether Claude Code actually reads `CLAUDE_NUM_TEAMMATES` or a different env var name
   - Recommendation: This is flagged as experimental in STATE.md; the env var name is correct per the v3.0 planning decision but should be validated in-process when possible

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (latest, already configured) |
| Config file | vitest.config.ts (root) |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-state.test.ts test/unit/workflow-resolver.test.ts` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TEAM-01 | `CLAUDE_NUM_TEAMMATES=N` added to agentEnv for claude-code with team config | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/agent-team-env.test.ts -x` | ❌ Wave 0 |
| TEAM-01 | Warning logged, no env var set for non-claude-code agent with team config | unit | same file | ❌ Wave 0 |
| TEAM-01 | No env var when `noTeam: true` | unit | same file | ❌ Wave 0 |
| TEAM-02 | Resolver scales memory by 1GB per teammate | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/workflow-resolver.test.ts -x` | ✅ extend existing |
| TEAM-02 | Solo run memory unchanged | unit | same file | ✅ extend existing |
| TEAM-03 | SlotManager sums weights instead of counting workers | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-state.test.ts -x` | ✅ extend existing |
| TEAM-03 | 3-person team occupies 3 slots | unit | same file | ✅ extend existing |
| TEAM-03 | Solo runs still consume 1 slot (backward compat) | unit | same file | ✅ extend existing |
| TEAM-04 | `skipCheckpoints: true` in RunPlan when team size > 1 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/workflow-resolver.test.ts -x` | ✅ extend existing |
| TEAM-04 | saveCheckpoint not called when skipCheckpoints=true | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/agent-team-checkpoint.test.ts -x` | ❌ Wave 0 |
| TEAM-05 | WorkflowFrontMatterSchema accepts `team: { size: 3 }` | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/workflow-file.test.ts -x` | ✅ extend existing |
| TEAM-05 | WorkflowFrontMatterSchema rejects size < 2 or > 5 | unit | same file | ✅ extend existing |
| TEAM-05 | WorkflowFrontMatterSchema .strict() rejects unknown keys in team object | unit | same file | ✅ extend existing |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-state.test.ts test/unit/workflow-resolver.test.ts test/unit/workflow-file.test.ts`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/agent-team-env.test.ts` — covers TEAM-01 (env var injection, warn-and-skip for non-claude-code, noTeam bypass)
- [ ] `test/unit/agent-team-checkpoint.test.ts` — covers TEAM-04 (saveCheckpoint gating via mock)

*(Existing test files for TEAM-02, TEAM-03, TEAM-05 will be extended with new `it()` cases rather than creating new files.)*

## Sources

### Primary (HIGH confidence)
- Direct code read: `src/orchestration/single.ts` — prepareExecution() structure, saveCheckpoint call sites (lines 214, 236, 245, 253), agentEnv assembly pattern
- Direct code read: `src/orchestrator/state.ts` — SlotManager.availableSlots() current implementation (`running.size` on line 90)
- Direct code read: `src/config/schema.ts` — WorkflowSchema shape, skills field (line 72), container resources schema (lines 107-109)
- Direct code read: `src/workflow/types.ts` — RunPlan structure, noSkills field (line 140), WorkflowFileConfig with skills (line 51)
- Direct code read: `src/workflow/resolver.ts` — resolveRunPlan() structure, noSkills mapping (line 189), memory config (lines 144-147)
- Direct code read: `src/workflow/workflow-file.ts` — WorkflowFrontMatterSchema with .strict() (line 99), skills field (line 97)
- Direct code read: `src/durability/recovery.ts` — recoverInterruptedRuns() marks interrupted, does not re-enqueue
- Direct code read: `src/durability/checkpoint.ts` — saveCheckpoint() signature
- Direct code read: `src/container/runner.ts` — parseMemory() helper (lines 110-114), createContainer() reads plan.container.resources.memory
- Direct code read: `src/index.ts` — --no-skills pattern (line 52), --no-review pattern (line 46)
- Direct code read: `test/unit/orchestrator-state.test.ts` — existing SlotManager tests, WorkerInfo cast as `{} as WorkerInfo`
- Direct code read: `test/unit/workflow-resolver.test.ts` — resolver test patterns, noSkills not yet tested
- Direct code read: `test/unit/skill-mount.test.ts` — Phase 26 test pattern for noSkills

### Secondary (MEDIUM confidence)
- `.planning/phases/27-agent-teams/27-CONTEXT.md` — user decisions, locked choices, code context section
- `.planning/REQUIREMENTS.md` — TEAM-01 through TEAM-05 requirement text
- `.planning/STATE.md` — v3.0 decisions, Phase 26 completed patterns, Phase 27 blocker note about experimental API

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already in use, verified by direct code read
- Architecture: HIGH — all patterns verified by reading Phase 26 implementation (skills, noSkills)
- Pitfalls: HIGH — derived from reading actual test files and code, not speculation
- CLAUDE_NUM_TEAMMATES env var name: MEDIUM — noted as experimental in STATE.md, could change

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (stable internal codebase; only risk is Claude Code's team API changing)
