# Phase 2: Workspace Management - Context

**Gathered:** 2026-03-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Per-issue workspace lifecycle management with hooks and safety invariants. Creates, reuses, and cleans up workspace directories for orchestrated agent runs. Separate from v1's `src/container/workspace.ts` (which handles temp-dir prep for container mounting). This is a new `src/workspace/` module for persistent per-issue workspaces.

</domain>

<decisions>
## Implementation Decisions

### Workspace reuse & cleanup
- Reuse workspace as-is on retry/continuation — agent picks up where it stopped. before_run hook can reset state if needed
- Delete workspace only when tracker issue reaches terminal state (closed/done). Successful runs keep workspace for potential follow-up
- Startup cleanup: fetch terminal-state issues from tracker, delete only their workspaces. Leave others untouched
- Log which workspaces are being deleted before removal — provides audit trail without blocking

### Workspace initialization
- Manager creates the directory; hooks handle all setup (clone, install, etc.)
- after_create hook is the customization point — manager is unopinionated about what goes in the workspace

### Hook failure semantics
- before_run hook failure: throw error with hook name, exit code, and stderr output. Orchestrator catches and decides retry/release
- after_create failure: abort (per R3.2) — workspace is in unknown state
- after_run failure: log and ignore (per R3.2) — work is already done
- before_remove failure: log and ignore (per R3.2) — cleanup proceeds

### Safety & error reporting
- Validate path containment on every operation (create, get, remove) — defense in depth
- Identifier sanitization: replace non-`[A-Za-z0-9._-]` with `_` (per R3.3)
- Path traversal attempts throw with descriptive error message

### Claude's Discretion
- Hook execution mechanism (child_process.exec vs spawn)
- Workspace config schema design (how hooks are specified in config)
- Internal workspace state tracking (Map vs filesystem checks)
- Whether to use fs.rm or rimraf for cleanup

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/container/workspace.ts`: Existing v1 workspace prep (temp dirs for containers). New module is separate but can reference patterns
- `src/tracker/types.ts`: TrackerIssue model provides `identifier` field used for workspace directory naming
- `src/config/schema.ts`: Zod schema patterns for workspace config section

### Established Patterns
- Eager config validation at startup (from Phase 1)
- $ENV_VAR resolution pattern (from Phase 1 token.ts)
- Plain Error with descriptive messages (no custom error classes)
- TypeScript ESM, async/await everywhere

### Integration Points
- `src/config/schema.ts` — add `workspace` section (root path, hook definitions, timeouts)
- Phase 5 orchestrator will call workspace manager for create/reuse/cleanup
- Tracker adapter provides terminal-state issue IDs for startup cleanup

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-workspace-management*
*Context gathered: 2026-03-07*
