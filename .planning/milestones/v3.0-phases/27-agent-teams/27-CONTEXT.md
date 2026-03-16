# Phase 27: Agent Teams - Context

**Gathered:** 2026-03-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Claude Code agent teams run inside containers on complex tasks, with container resources and slot weights automatically scaled to team size. This phase adds team activation via env vars, a `team:` workflow config section, memory scaling, weighted slot management, and checkpoint bypass for team runs. Does NOT include multi-agent delegation hierarchies, persistent team sessions across crashes, or team support for non-Claude-Code agents.

</domain>

<decisions>
## Implementation Decisions

### Team Activation Mechanism
- Activate team mode via `CLAUDE_NUM_TEAMMATES=N` env var set on the container
- Single env var only — no role hints, no prompt wrapping, no CLI flags to Claude Code
- Add `--no-team` CLI flag to disable team mode for a specific run (mirrors `--no-skills` pattern from Phase 26)
- Claude Code only — if team config is present but agent type isn't claude-code, log a warning and run without team mode (non-breaking)
- Env var added to `agentEnv` array in `prepareExecution()`, same pattern as `ANTHROPIC_API_KEY` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`

### Workflow Config Shape
- Minimal config: `team: { size: 3 }` — size only, no roles or coordination mode
- Team size capped at 5 in Zod schema: `z.number().int().min(2).max(5)`
- `--team-size N` CLI flag overrides workflow definition (follows 4-layer merge: defaults → forgectl.yaml → WORKFLOW.md → CLI flags)
- Agent type mismatch (team + non-claude-code): warn and ignore, don't error

### Resource Scaling
- Memory scales: final memory = base + (teammates * 1GB), computed in resolver before RunPlan
- CPU does NOT scale — teammates are I/O-bound (API calls), not CPU-bound
- `createContainer()` stays unchanged — it just reads the already-computed `plan.container.resources.memory`
- Resolver writes the scaled memory value directly into RunPlan

### Slot Weight Accounting
- All runs get a weight: 1 for solo, team size for teams (uniform model)
- `SlotManager.availableSlots()` sums weights across running workers instead of counting `running.size`
- A 3-person team occupies 3 slots, preventing OOM from concurrent team runs
- Non-team runs are implicitly weight=1, so existing behavior is preserved

### Checkpoint Bypass
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

</decisions>

<specifics>
## Specific Ideas

- "Agent teams are prompt+env concern, not architectural" (v3.0 planning decision) — forgectl sets env vars, Claude Code handles teammate coordination internally
- `--no-team` flag enables clean A/B testing: run same workflow with and without team to compare quality/cost
- Uniform weight model: a solo run is just a team of 1, no special cases in SlotManager

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `prepareExecution()` at `src/orchestration/single.ts:61`: Already assembles `agentEnv` array — `CLAUDE_NUM_TEAMMATES` added here
- `SlotManager` at `src/orchestrator/state.ts:79`: Needs weight-aware `availableSlots()` — currently uses `running.size`
- `WorkflowSchema` at `src/config/schema.ts:41`: Zod schema to extend with `team` section (same pattern as `skills` addition in Phase 26)
- `WorkflowFileConfig` at `src/workflow/types.ts:9`: TypeScript interface to extend with `team` field
- `RunPlan` at `src/workflow/types.ts:97`: Needs `team` and `skipCheckpoints` fields
- `parseMemory()` at `src/container/runner.ts:110`: Helper for memory string parsing — resolver can use for scaling math

### Established Patterns
- `--no-skills` pattern (Phase 26): Commander `--no-X` sets `opts.X = false`, resolver maps to `noX: true` on RunPlan
- 4-layer config merge: defaults → forgectl.yaml → WORKFLOW.md → CLI flags — team config participates
- Env var injection in `prepareExecution()`: agent-type-specific env vars added to `agentEnv` array
- Optional fields on RunPlan (e.g., `noSkills?: boolean`) for backward compatibility

### Integration Points
- `prepareExecution()` — add `CLAUDE_NUM_TEAMMATES` env var when team config present
- Resolver — compute scaled memory, set `skipCheckpoints`, populate `team` on RunPlan
- `SlotManager` — change from `running.size` to sum of weights
- `WorkerInfo` — needs to carry slot weight for SlotManager calculations
- `executeSingleAgent()` — gate `saveCheckpoint()` calls on `!plan.skipCheckpoints`
- Crash recovery at `src/durability/recovery.ts` — team runs re-enqueue fresh, don't resume

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 27-agent-teams*
*Context gathered: 2026-03-13*
