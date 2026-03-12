# Phase 15: Browser-Use Integration - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

forgectl can dispatch browser-based agents for research and web tasks using the same workflow system as code agents. A BrowserUseSession adapter implements AgentSession, a Python sidecar runs inside Docker with an HTTP bridge, and a research workflow template configures browser-use for data gathering tasks.

</domain>

<decisions>
## Implementation Decisions

### Sidecar communication
- HTTP REST protocol between TypeScript adapter and Python sidecar
- Sidecar runs inside the same Docker container as the workspace (single container lifecycle)
- Fixed port (e.g., 8765) inside container — no port conflicts since each run gets its own container
- Health endpoint polling (`GET /health`) every 500ms until 200 response, timeout after 30s
- Sidecar started as background process inside container, adapter communicates via `localhost:PORT`

### Browser automation library
- Use browser-use (AI-native browser automation, built on Playwright)
- Pass through forgectl's configured model and API key to browser-use — similar to how Claude CLI gets credentials, browser-use agent uses the same LLM provider the user configured
- Headless only inside Docker — no display server, screenshots captured programmatically for debugging/audit
- Bundled Dockerfile shipped with forgectl, built on first use via existing `ensureImage()` pattern — users can customize, no registry dependency

### Task & output contract
- Adapter sends natural language task to sidecar (user's task as-is, e.g., "Research competitor pricing for X")
- browser-use handles browsing autonomously — no structured commands or step-by-step instructions
- Output format: markdown report (human-readable findings) + JSON data (structured extractions) + screenshots of key pages
- All output collected to `/output` directory (markdown, JSON, screenshots subdirectory)
- Streaming action log via SSE — sidecar streams action/observation pairs as browsing happens, adapter can log or forward to UI

### Research workflow scope
- Scope: research and data gathering only — competitive analysis, market research, web data collection
- No form filling, account interactions, or credential management for target sites
- Open network — full internet access, container isolation provides the security boundary

### Claude's Discretion
- Validation criteria for research output (output exists + content quality checks)
- Whether to create new 'browser-research' workflow or replace existing 'research' workflow
- SSE streaming implementation details
- Sidecar HTTP API endpoint design (routes, request/response schemas)
- Dockerfile contents (base image, Python deps, Chromium installation)
- How to pass LLM credentials from forgectl config to browser-use inside container

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/agent/session.ts`: AgentSession interface (invoke, isAlive, close) — browser-use adapter implements this
- `src/agent/registry.ts`: Simple ADAPTERS map — add `"browser-use"` entry
- `src/agent/appserver-session.ts`: AppServerSession pattern for persistent sidecar communication — reference for HTTP bridge design
- `src/container/builder.ts`: `ensureImage()` with Dockerfile build — reuse for browser-use image
- `src/container/runner.ts`: `execInContainer()` for starting sidecar process as background task
- `src/workflow/builtins/research.ts`: Existing research workflow — pattern for browser-use workflow definition

### Established Patterns
- Agent adapters are stateless — just build shell commands that read from prompt files
- Sessions are factory-created via `createAgentSession()` — add browser-use branch
- Container lifecycle: create → exec → validate → collect output → cleanup
- Validation/feedback loop is agent-agnostic — works with any session type
- Config merge: 4-layer priority (defaults → forgectl.yaml → WORKFLOW.md → CLI flags)

### Integration Points
- `src/agent/registry.ts`: Register browser-use adapter
- `src/config/schema.ts`: Add `"browser-use"` to AgentType enum
- `src/workflow/registry.ts`: Register browser-use workflow in BUILTINS
- `src/orchestration/single.ts`: executeSingleAgent() — browser-use session integrates via same AgentSession interface
- `src/container/secrets.ts`: May need extension for passing LLM API keys to sidecar

</code_context>

<specifics>
## Specific Ideas

- Browser-use agent should use the same LLM provider the user already configured for forgectl — similar to giving it access to the Claude CLI, not a separate API key setup
- Screenshots serve dual purpose: audit trail (what the agent saw) and debugging (when things go wrong)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 15-browser-use-integration*
*Context gathered: 2026-03-10*
