# Phase 15: Browser-Use Integration - Research

**Researched:** 2026-03-10
**Domain:** AI browser automation, Python sidecar architecture, Docker container orchestration
**Confidence:** HIGH

## Summary

Phase 15 integrates browser-use (an open-source Python library for AI-driven browser automation) into forgectl's existing agent system. The core challenge is bridging TypeScript (forgectl) to Python (browser-use) via an HTTP sidecar running inside the same Docker container. The existing `Dockerfile.research-browser` already bundles browser-use, Playwright+Chromium, and LangChain provider packages -- this is a strong foundation.

The architecture follows a pattern similar to AppServerSession: the TypeScript adapter starts a Python HTTP server inside the container, polls for health, sends tasks via REST, and streams results via SSE. The key difference from existing agents is that browser-use is not a CLI tool -- it is a Python async library that needs a thin HTTP wrapper (the "sidecar") to expose its functionality over REST.

**Primary recommendation:** Build a thin Python FastAPI/Flask sidecar (~150 lines) that wraps browser-use Agent, ship it inside the Docker image, and create a BrowserUseSession class in TypeScript that implements AgentSession by communicating with this sidecar over HTTP.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions
- HTTP REST protocol between TypeScript adapter and Python sidecar
- Sidecar runs inside the same Docker container as the workspace (single container lifecycle)
- Fixed port (e.g., 8765) inside container -- no port conflicts since each run gets its own container
- Health endpoint polling (`GET /health`) every 500ms until 200 response, timeout after 30s
- Sidecar started as background process inside container, adapter communicates via `localhost:PORT`
- Use browser-use (AI-native browser automation, built on Playwright)
- Pass through forgectl's configured model and API key to browser-use
- Headless only inside Docker -- no display server, screenshots captured programmatically
- Bundled Dockerfile shipped with forgectl, built on first use via existing `ensureImage()` pattern
- Adapter sends natural language task to sidecar (user's task as-is)
- browser-use handles browsing autonomously -- no structured commands
- Output format: markdown report + JSON data + screenshots of key pages
- All output collected to `/output` directory
- Streaming action log via SSE -- sidecar streams action/observation pairs
- Scope: research and data gathering only
- No form filling, account interactions, or credential management for target sites
- Open network -- full internet access, container isolation provides security

### Claude's Discretion
- Validation criteria for research output (output exists + content quality checks)
- Whether to create new 'browser-research' workflow or replace existing 'research' workflow
- SSE streaming implementation details
- Sidecar HTTP API endpoint design (routes, request/response schemas)
- Dockerfile contents (base image, Python deps, Chromium installation)
- How to pass LLM credentials from forgectl config to browser-use inside container

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| BROW-01 | Browser-use agent adapter implementing AgentSession interface | BrowserUseSession class pattern, HTTP bridge communication, health polling, task invocation |
| BROW-02 | Self-hosted Python sidecar in Docker container with HTTP bridge | Python sidecar design, Dockerfile (existing), FastAPI/aiohttp server, SSE streaming |
| BROW-03 | Research/web workflow template for competitive analysis, data gathering | New `browser-research` workflow definition, validation steps, output collection patterns |

</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| browser-use | 0.12.1 | AI browser automation (Python) | Already in Dockerfile.research-browser, MIT, built on Playwright |
| langchain-anthropic | latest | ChatAnthropic for browser-use LLM | Already in Dockerfile, provides Claude model support |
| langchain-openai | latest | ChatOpenAI for browser-use LLM | Already in Dockerfile, provides OpenAI model support |
| playwright | latest | Browser engine (Chromium) | Already in Dockerfile, playwright install --with-deps chromium |
| aiohttp | latest | Python HTTP server for sidecar | Lightweight async, no extra deps needed (browser-use uses asyncio) |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| dockerode | (existing) | Container exec for starting sidecar | Start sidecar process, health check |
| undici/node:http | (built-in) | HTTP client in TypeScript adapter | Call sidecar REST endpoints |
| EventSource | (built-in/polyfill) | SSE client for streaming | Consume action log stream from sidecar |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| aiohttp | FastAPI+uvicorn | FastAPI adds ~50MB deps; aiohttp is lighter and sufficient for 4 endpoints |
| aiohttp | Flask | Flask is sync-first; browser-use is async, aiohttp is native async |
| Custom sidecar | browser-use Cloud API | Requires external service + API key; self-hosted is the locked decision |

**Installation:** Already handled by Dockerfile.research-browser. Sidecar Python script is shipped as a file, not pip-installed.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── agent/
│   ├── browser-use-session.ts    # BrowserUseSession implements AgentSession
│   └── browser-use-adapter.ts    # AgentAdapter for registry (minimal)
├── container/
│   └── (existing builder.ts)     # ensureImage() handles Dockerfile.research-browser
sidecar/
└── browser-use-sidecar.py        # Python HTTP server (~150 lines)
dockerfiles/
└── Dockerfile.research-browser   # Already exists, needs minor updates
```

### Pattern 1: BrowserUseSession (HTTP Bridge)
**What:** A TypeScript class implementing AgentSession that communicates with a Python sidecar over HTTP inside the container.
**When to use:** When agent type is "browser-use" in workflow config.
**Example:**
```typescript
// Source: Based on AppServerSession pattern
export class BrowserUseSession implements AgentSession {
  private alive = false;
  private sidecarPort = 8765;

  constructor(
    private container: Docker.Container,
    private agentOptions: AgentOptions,
    private env: string[],
    private sessionOptions?: AgentSessionOptions,
  ) {}

  async invoke(prompt: string, options?: InvokeOptions): Promise<AgentResult> {
    if (!this.alive) {
      await this.startSidecar();
      await this.waitForHealth();
      this.alive = true;
    }
    return this.runTask(prompt, options?.timeout ?? this.agentOptions.timeout);
  }

  private async startSidecar(): Promise<void> {
    // execInContainer with detached python process
    await execInContainer(this.container, [
      "sh", "-c",
      `python3 /usr/local/bin/browser-use-sidecar.py --port ${this.sidecarPort} &`
    ], { env: this.env });
  }

  private async waitForHealth(): Promise<void> {
    // Poll GET /health every 500ms, timeout 30s
  }

  private async runTask(task: string, timeout: number): Promise<AgentResult> {
    // POST /task { task, model, provider }
    // Optionally consume SSE at /task/{id}/stream for logging
    // Wait for completion, collect result
  }
}
```

### Pattern 2: Python Sidecar HTTP Server
**What:** A minimal Python aiohttp server that wraps browser-use Agent.
**When to use:** Runs inside the Docker container as a background process.
**Example:**
```python
# Source: browser-use docs + aiohttp patterns
from aiohttp import web
from browser_use import Agent, Browser, BrowserConfig
import json, asyncio, os

async def health(request):
    return web.json_response({"status": "ok"})

async def run_task(request):
    data = await request.json()
    task = data["task"]
    provider = data.get("provider", "anthropic")
    model = data.get("model", "claude-sonnet-4-20250514")

    # Create LLM based on provider
    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic
        llm = ChatAnthropic(model_name=model)
    elif provider == "openai":
        from langchain_openai import ChatOpenAI
        llm = ChatOpenAI(model=model)

    browser = Browser(config=BrowserConfig(headless=True))
    agent = Agent(
        task=task,
        llm=llm,
        browser=browser,
        generate_gif=False,
        save_conversation_path="/output/conversation.json",
    )

    result = await agent.run()
    await browser.close()

    return web.json_response({
        "status": "completed",
        "output": result.final_result() if result else "",
        "history": [str(h) for h in (result.history if result else [])],
    })

app = web.Application()
app.router.add_get("/health", health)
app.router.add_post("/task", run_task)
web.run_app(app, port=int(os.environ.get("SIDECAR_PORT", "8765")))
```

### Pattern 3: Credential Pass-through
**What:** Pass LLM API keys from forgectl config into the container as environment variables, which browser-use's LangChain providers pick up automatically.
**When to use:** Always -- browser-use needs LLM access.
**Example:**
```typescript
// In prepareExecution or BrowserUseSession
// Anthropic: ANTHROPIC_API_KEY env var (langchain-anthropic reads it)
// OpenAI: OPENAI_API_KEY env var (langchain-openai reads it)
// The existing prepareClaudeMounts/prepareCodexMounts already set these!
// Just need to forward agentEnv to sidecar process
```

### Pattern 4: Workflow Registration
**What:** New `browser-research` workflow alongside existing `research` workflow.
**When to use:** Keep both -- `research` uses agent CLI + Puppeteer, `browser-research` uses browser-use sidecar.
**Recommendation:** Create new `browser-research` workflow rather than replacing `research`. This preserves backward compatibility and gives users choice.

### Anti-Patterns to Avoid
- **Starting sidecar synchronously and blocking:** Start as background process, poll health. Never wait for startup in the exec call itself.
- **Parsing sidecar stdout for results:** Use HTTP responses, not stdout scraping. Sidecar stdout goes to container logs.
- **Exposing sidecar port to host:** Port stays internal to container. No Docker port mapping needed.
- **Using browser-use Cloud API:** Self-hosted is the locked decision. No BROWSER_USE_API_KEY.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Browser automation | Custom Playwright scripts | browser-use Agent | Handles page understanding, navigation, extraction autonomously |
| LLM integration for browser | Custom API calls | langchain-anthropic/openai | browser-use expects LangChain chat models |
| Headless Chromium in Docker | Manual apt-get chromium | `playwright install --with-deps chromium` | Handles all system deps automatically |
| HTTP server in Python | Raw socket server | aiohttp | Async, battle-tested, minimal |
| SSE streaming | Custom chunked encoding | aiohttp SSE / EventSource | Well-defined protocol, built-in browser support |
| Health check polling | Custom retry loop | Simple setInterval + fetch with timeout | Pattern is straightforward enough |

**Key insight:** The Python sidecar should be thin -- just HTTP wiring around browser-use. All intelligence lives in browser-use itself.

## Common Pitfalls

### Pitfall 1: Sidecar Startup Race Condition
**What goes wrong:** TypeScript sends task before Python sidecar is ready.
**Why it happens:** `exec` returns immediately for background processes; sidecar needs time to import heavy Python modules (playwright, langchain).
**How to avoid:** Health endpoint polling at 500ms intervals with 30s hard timeout. First Chromium launch inside container can take 5-10s.
**Warning signs:** Connection refused errors on first task.

### Pitfall 2: Chromium Sandbox in Docker
**What goes wrong:** Chromium fails to launch with sandbox errors.
**Why it happens:** Docker containers don't have the kernel features Chromium's sandbox expects.
**How to avoid:** Set `BROWSER_USE_CHROME_NO_SANDBOX=1` and `IN_DOCKER=True` environment variables. BrowserConfig `headless=True` is also required.
**Warning signs:** "Failed to launch browser" errors mentioning SUID sandbox.

### Pitfall 3: Memory Exhaustion
**What goes wrong:** Container OOM-killed during browser automation.
**Why it happens:** Chromium + Python + LLM API calls can use 2-3GB easily.
**How to avoid:** Container memory limit should be at least 4GB (current default). Set `--ipc=host` or increase `/dev/shm` size in container config.
**Warning signs:** Sudden process termination, exit code 137.

### Pitfall 4: Sidecar Process Cleanup
**What goes wrong:** Orphaned Python/Chromium processes after task completion.
**Why it happens:** Background process not properly terminated on container cleanup.
**How to avoid:** BrowserUseSession.close() should POST /shutdown to sidecar. Container destroy handles the rest as fallback.
**Warning signs:** Resource leaks in long-running daemon scenarios.

### Pitfall 5: API Key Not Reaching Browser-Use
**What goes wrong:** browser-use agent fails with "missing API key" errors.
**Why it happens:** Environment variables set for the container's main process don't propagate to exec'd background processes.
**How to avoid:** Pass env vars explicitly when exec'ing the sidecar process. The `execInContainer` `env` option does this correctly.
**Warning signs:** 401/403 errors from Anthropic/OpenAI API.

### Pitfall 6: Output Directory Permissions
**What goes wrong:** browser-use can't write screenshots or reports to /output.
**Why it happens:** Container user doesn't have write access to mounted output directory.
**How to avoid:** Ensure /output directory exists and is writable before sidecar starts (the existing Dockerfile already does `mkdir -p /output`).
**Warning signs:** Permission denied errors in sidecar logs.

## Code Examples

### Creating BrowserUseSession in Factory
```typescript
// Source: Based on existing createAgentSession pattern in session.ts
export function createAgentSession(
  agentType: string,
  container: Docker.Container,
  agentOptions: AgentOptions,
  env: string[],
  sessionOptions?: AgentSessionOptions,
): AgentSession {
  if (agentType === "browser-use") {
    return new BrowserUseSession(container, agentOptions, env, sessionOptions);
  }
  if (agentType === "codex" && sessionOptions?.useAppServer) {
    return new AppServerSession(container, agentOptions, env, sessionOptions);
  }
  const adapter: AgentAdapter = getAgentAdapter(agentType);
  return new OneShotSession(container, adapter, agentOptions, env, sessionOptions);
}
```

### Adding to AgentType Enum
```typescript
// Source: src/config/schema.ts
export const AgentType = z.enum(["claude-code", "codex", "browser-use"]);
```

### Adding to Agent Registry
```typescript
// Source: src/agent/registry.ts -- browser-use doesn't use AgentAdapter pattern
// since it's not a CLI tool. The registry needs a guard or the factory
// needs to handle browser-use before calling getAgentAdapter.
// Recommendation: handle in createAgentSession directly (before registry lookup).
```

### Credential Pass-through in prepareExecution
```typescript
// Source: Based on src/orchestration/single.ts prepareExecution
// For browser-use, we need BOTH provider keys (user might use Claude or OpenAI)
// The existing pattern already sets ANTHROPIC_API_KEY or OPENAI_API_KEY
// based on agent.type. For browser-use, read from forgectl config which
// LLM provider to use, and set the appropriate key.
if (plan.agent.type === "browser-use") {
  // Determine LLM provider from workflow config or default to claude
  // Try Claude auth first, fall back to OpenAI
  const claudeAuth = await getClaudeAuth();
  if (claudeAuth?.type === "api_key" && claudeAuth.apiKey) {
    agentEnv.push(`ANTHROPIC_API_KEY=${claudeAuth.apiKey}`);
  }
  // Also check if OpenAI key available for fallback
  const codexAuth = await getCodexAuth();
  if (codexAuth?.type === "api_key" && codexAuth.apiKey) {
    agentEnv.push(`OPENAI_API_KEY=${codexAuth.apiKey}`);
  }
  agentEnv.push("IN_DOCKER=True");
  agentEnv.push("BROWSER_USE_CHROME_NO_SANDBOX=1");
}
```

### Browser-Research Workflow Definition
```typescript
// Source: Based on src/workflow/builtins/research.ts pattern
export const browserResearchWorkflow: WorkflowDefinition = {
  name: "browser-research",
  description: "AI-driven browser research using browser-use for competitive analysis and data gathering",
  container: {
    image: "forgectl/research-browser",
    network: { mode: "open", allow: [] },
  },
  input: { mode: "files", mountPath: "/input" },
  tools: ["browser-use", "python3", "curl", "jq"],
  system: `You are an AI research agent with browser automation capabilities.
You browse the web autonomously to complete research tasks.

Context files (if any) are in /input.
All output goes to /output.

Rules:
- Produce a markdown report in /output/report.md
- Include structured data in /output/data.json when applicable
- Screenshots of key pages are saved automatically to /output/screenshots/
- Cite all sources with URLs
- Distinguish facts from analysis/opinion
- Include an executive summary at the top`,
  validation: {
    steps: [
      { name: "report-exists", command: "test -f /output/report.md", retries: 2, description: "Research report exists" },
      { name: "has-content", command: "wc -w /output/report.md | awk '{if($1<200) exit 1}'", retries: 1, description: "Report has at least 200 words" },
      { name: "has-sources", command: "grep -c 'http' /output/report.md | awk '{if($1<2) exit 1}'", retries: 1, description: "Report cites at least 2 URLs" },
    ],
    on_failure: "output-wip",
  },
  output: { mode: "files", path: "/output", collect: ["**/*.md", "**/*.json", "**/*.png", "**/*.jpg"] },
  review: {
    enabled: true,
    system: `You are a fact-checker. Review this research report.
Check for: unsupported claims, missing citations, logical gaps.
If acceptable, respond with: APPROVED
If issues exist, list them numbered.`,
  },
  autonomy: "full",
};
```

### SSE Streaming from Sidecar
```python
# Source: aiohttp SSE pattern
from aiohttp import web
from aiohttp_sse import sse_response

async def task_stream(request):
    task_id = request.match_info["task_id"]
    async with sse_response(request) as resp:
        # browser-use step callback pushes events
        while not task_complete[task_id]:
            if events_queue[task_id]:
                event = events_queue[task_id].pop(0)
                await resp.send(json.dumps(event), event="action")
            await asyncio.sleep(0.1)
        await resp.send(json.dumps({"status": "done"}), event="complete")
    return resp
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Puppeteer + manual scripts | browser-use AI agent | 2024-2025 | AI handles navigation/extraction, no selectors needed |
| Selenium | Playwright (via browser-use) | 2023+ | Faster, more reliable, built-in waits |
| headless-chrome-shell | Playwright `--with-deps` | 2024+ | Automated dependency management |
| ChatBrowserUse (proprietary) | LangChain providers | 2025+ | Any LLM works, not locked to browser-use cloud |

**Deprecated/outdated:**
- Puppeteer: Still works but browser-use provides higher-level AI abstraction
- browser-use Cloud SDK (`browser-use-sdk`): Not needed for self-hosted -- use open-source `browser-use` package directly
- `ChatBrowserUse()` model: Requires browser-use cloud; use `ChatAnthropic`/`ChatOpenAI` for self-hosted

## Open Questions

1. **Sidecar process lifecycle on validation retry**
   - What we know: Validation loop restarts agent from scratch. Current agents are stateless CLI calls.
   - What's unclear: Should sidecar stay running between retries or restart each time?
   - Recommendation: Keep sidecar alive during validation retries (expensive to restart Chromium). Only close on session.close().

2. **LLM provider selection for browser-use**
   - What we know: User configures agent type (claude-code/codex) which implies provider. browser-use needs a LangChain model.
   - What's unclear: Should browser-use use the same provider as the configured agent, or allow override?
   - Recommendation: Default to Anthropic (Claude) since forgectl is Claude-first. Allow override via workflow config or env var.

3. **Container shared memory for Chromium**
   - What we know: Chromium in Docker can crash without adequate /dev/shm.
   - What's unclear: Whether current container creation sets ShmSize.
   - Recommendation: Add `ShmSize: 256 * 1024 * 1024` (256MB) to container HostConfig for browser-use runs.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest |
| Config file | vitest.config.ts |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/browser-use` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BROW-01 | BrowserUseSession implements AgentSession | unit | `npx vitest run test/unit/browser-use-session.test.ts -x` | No - Wave 0 |
| BROW-01 | createAgentSession returns BrowserUseSession for "browser-use" | unit | `npx vitest run test/unit/session.test.ts -x` | Exists but needs update |
| BROW-01 | AgentType enum includes "browser-use" | unit | `npx vitest run test/unit/config.test.ts -x` | Exists but needs update |
| BROW-01 | Health polling retries and times out correctly | unit | `npx vitest run test/unit/browser-use-session.test.ts -x` | No - Wave 0 |
| BROW-02 | Sidecar HTTP endpoints (health, task, shutdown) | unit | `npx vitest run test/unit/browser-use-sidecar.test.ts -x` | No - Wave 0 |
| BROW-02 | Dockerfile builds successfully | integration | `docker build -f dockerfiles/Dockerfile.research-browser .` | Manual |
| BROW-03 | browser-research workflow registered in BUILTINS | unit | `npx vitest run test/unit/workflows.test.ts -x` | Exists but needs update |
| BROW-03 | Validation steps check output existence and quality | unit | `npx vitest run test/unit/browser-use-workflow.test.ts -x` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/browser-use-session.test.ts test/unit/session.test.ts -x`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/browser-use-session.test.ts` -- covers BROW-01 (session lifecycle, health polling, task invocation)
- [ ] `test/unit/browser-use-sidecar.test.ts` -- covers BROW-02 (sidecar API contract tests, mock HTTP)
- [ ] `test/unit/browser-use-workflow.test.ts` -- covers BROW-03 (workflow definition, validation steps)
- [ ] Update `test/unit/session.test.ts` -- add browser-use branch to factory tests
- [ ] Update `test/unit/workflows.test.ts` -- verify browser-research in BUILTINS

## Sources

### Primary (HIGH confidence)
- Existing codebase: `src/agent/session.ts`, `src/agent/appserver-session.ts`, `src/orchestration/single.ts` -- established patterns
- Existing codebase: `dockerfiles/Dockerfile.research-browser` -- browser-use already bundled
- [browser-use GitHub](https://github.com/browser-use/browser-use) -- v0.12.1, MIT license, Python >=3.11
- [browser-use PyPI](https://pypi.org/project/browser-use/) -- v0.12.1 released 2026-03-03
- [Playwright Docker docs](https://playwright.dev/python/docs/docker) -- official container guidance
- [browser-use Agent parameters](https://docs.browser-use.com/open-source/customize/agent/all-parameters) -- full API reference

### Secondary (MEDIUM confidence)
- [browser-use Docker discussion](https://github.com/browser-use/browser-use/discussions/1958) -- IN_DOCKER=True, env vars, official image
- [LangChain ChatAnthropic](https://docs.langchain.com/oss/python/integrations/chat/anthropic) -- ANTHROPIC_API_KEY auto-read

### Tertiary (LOW confidence)
- SSE streaming approach: inferred from aiohttp patterns, not verified with browser-use step callbacks specifically

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - browser-use already in Dockerfile, well-documented, actively maintained
- Architecture: HIGH - follows established AppServerSession pattern, HTTP bridge is straightforward
- Pitfalls: HIGH - Docker+Chromium pitfalls well-documented in Playwright and browser-use communities
- Sidecar API design: MEDIUM - aiohttp choice reasonable but sidecar is new code, SSE details need validation
- LLM credential flow: HIGH - LangChain providers auto-read env vars, existing mount pattern works

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (browser-use is fast-moving but core API stable at v0.12)
