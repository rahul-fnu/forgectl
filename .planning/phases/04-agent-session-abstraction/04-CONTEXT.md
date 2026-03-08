# Phase 4: Agent Session Abstraction - Context

**Gathered:** 2026-03-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Unified session interface supporting both one-shot CLI and persistent subprocess modes. Refactors existing agent invocation into an AgentSession abstraction with invoke/isAlive/close lifecycle. Adds AppServerSession for Codex JSON-RPC persistent sessions. Activity tracking for stall detection. The orchestration state machine (dispatch, retry, reconciliation) is Phase 5.

</domain>

<decisions>
## Implementation Decisions

### Session result shape
- Structured typed result with status enum: `completed | failed | timeout | user_input_required`
- Includes: stdout, stderr, status, tokenUsage, durationMs, turnCount
- Token usage always present with zero defaults (`{ input: 0, output: 0, total: 0 }`) — no null checks downstream
- Separate stdout and stderr fields (not combined) — stderr for diagnostics, stdout for agent response

### One-shot refactor scope
- OneShotSession wraps existing `invokeAgent()` internally — AgentAdapter interface stays, session adds lifecycle on top
- AgentSession interface + factory in new `src/agent/session.ts` — registry.ts stays for adapter lookup, factory uses registry internally
- OneShotSession receives injected Docker container + adapter in constructor — orchestrator manages container lifecycle separately
- Migrate `forgectl run` to use AgentSession too — single code path for all agent invocations, not just orchestrator

### Codex app-server protocol
- Spawn codex app-server via Docker exec inside container — consistent with isolation model
- Auto-approve all approval requests — agent is inside isolated container, matches `--yolo` behavior in one-shot mode
- Multi-turn: first turn sends full rendered prompt, continuation turns send guidance/error context only — saves tokens
- Direct JSON-RPC handling in AppServerSession — line-delimited JSON on stdio, no separate abstraction layer

### Activity tracking contract
- Callback-based: session constructor takes `onActivity: () => void` callback, called on any output
- One-shot: any stdout/stderr chunk counts as activity (no filtering)
- Signal-only callback with no arguments — orchestrator just needs "still alive" signal
- `close()` kills the running process — enables orchestrator to force-stop stalled agents. `isAlive()` returns false after close

### Claude's Discretion
- JSON-RPC message framing details (line-delimited vs content-length headers)
- How to map ExecResult exit codes to the status enum
- Internal session state management (tracking invocation state, preventing double-invoke)
- Turn timeout implementation details
- Read timeout for handshake implementation

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/agent/types.ts`: AgentAdapter interface (buildShellCommand) — OneShotSession wraps this
- `src/agent/invoke.ts`: invokeAgent() — prompt file writing + container exec. OneShotSession delegates to this
- `src/agent/registry.ts`: getAgentAdapter() name→adapter lookup — factory uses this to resolve adapter before creating session
- `src/container/runner.ts`: execInContainer() + ExecResult — underlying execution primitive

### Established Patterns
- Closure-based adapter pattern for private state (Phase 1)
- Callback-based execFile for cleaner error field access (Phase 2)
- Adapter interface + registry lookup by string key
- Zod schemas with .default() for config sections
- TypeScript ESM with .js import extensions

### Integration Points
- `src/agent/invoke.ts` — OneShotSession wraps invokeAgent()
- `src/orchestration/single.ts` — executeSingleAgent() will use AgentSession instead of direct invokeAgent
- `src/cli/run.ts` — forgectl run command migrated to use AgentSession
- Phase 5 orchestrator will create sessions per dispatch via AgentSessionFactory

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-agent-session-abstraction*
*Context gathered: 2026-03-08*
