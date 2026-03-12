# Phase 13: Governance & Approvals - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Each workflow has a configurable autonomy level that determines whether runs need human approval, and auto-approve rules can bypass approval gates when conditions are met. Budget enforcement is limited to cost thresholds in auto-approve rules (not standalone budget system).

</domain>

<decisions>
## Implementation Decisions

### Autonomy level behavior
- Four levels forming a clean spectrum: full → interactive → semi → supervised
- **full**: No gates at all — agent executes immediately, commits output, posts results. Identical to current behavior.
- **interactive**: Agent runs immediately, but output requires human approval before landing (post-gate only).
- **semi**: Human approves dispatch before agent starts, then agent runs autonomously (pre-gate only).
- **supervised**: Approve before AND after — human approves dispatch, then approves output after execution + validation.
- Default autonomy level when not specified: **full** (backward compatible — existing workflows unchanged).
- Autonomy field added to WorkflowSchema and WorkflowFileConfig.

### Approval gate placement
- **Pre-execution gate**: New `pending_approval` run status. Run is created, enters pending_approval, waits for human action. Distinct from `waiting_for_input` (mid-run pause).
- **Post-execution gate**: New `pending_output_approval` run status. After validation passes, output is collected but not landed. Approval triggers output landing.
- Approval/rejection triggered via **REST API endpoints**: `POST /api/v1/runs/:id/approve` and `POST /api/v1/runs/:id/reject`. Phase 14 wires GitHub reactions to these same endpoints.
- **Three approval states**: approve, reject, revision_requested. Revision sends the run back with feedback — agent re-executes incorporating the feedback (auto-retry on revise).

### Auto-approve rules
- Configured in **WORKFLOW.md only** — co-located with workflow policy. Teams version-control their rules alongside autonomy level.
- Multiple conditions combine with **AND logic** — all must pass for auto-approve. Any failing condition triggers manual approval.
- Supported condition types:
  - **Label match**: Auto-approve if issue has a specific label (e.g., 'safe', 'trivial')
  - **Workflow name pattern**: Auto-approve for specific workflow names/patterns (e.g., 'docs-*')
  - **Cost threshold**: Auto-approve if actual cost < $X (post-execution, uses real token counts from Phase 11)
- Cost threshold evaluated **post-execution** using actual cost, not pre-flight estimates. Works with interactive/supervised post-gate.
- No file count threshold (dropped — label match and workflow pattern cover blast radius control).

### Claude's Discretion
- Approval state machine implementation details (table schema, transition functions)
- How revision_requested re-dispatches (prompt construction with feedback)
- WORKFLOW.md YAML syntax for autonomy and auto_approve fields
- How auto-approve evaluation integrates with the dispatcher flow

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/durability/pause.ts`: PauseContext/ResumeResult types and pause/resume functions — pattern for state transitions
- `src/storage/schema.ts`: runs table with status field — extend with new statuses
- `src/workflow/types.ts`: WorkflowFileConfig — add autonomy and auto_approve fields
- `src/config/schema.ts`: WorkflowSchema with zod validation — add autonomy enum and auto_approve schema
- `src/logging/events.ts`: emitRunEvent — use for approval events

### Established Patterns
- Run status transitions: status field on runs table, updated via runRepo.updateStatus()
- REST API routes: Fastify routes in `src/daemon/routes.ts` with standard `{ error: { code, message } }` envelope
- Config merge: 4-layer priority (defaults → forgectl.yaml → WORKFLOW.md → CLI flags)
- Fire-and-forget dispatch: `void executeWorkerAndHandle()` in dispatcher.ts — gate must be inserted before this

### Integration Points
- `src/orchestrator/dispatcher.ts`: dispatchIssue() — insert pre-gate check before fire-and-forget worker
- `src/orchestration/single.ts`: executeSingleAgent() — insert post-gate check after validation, before output collection
- `src/daemon/routes.ts`: Add approve/reject/revision endpoints alongside existing resume endpoint
- `src/workflow/map-front-matter.ts`: Parse new autonomy and auto_approve fields from WORKFLOW.md front matter

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 13-governance-approvals*
*Context gathered: 2026-03-10*
