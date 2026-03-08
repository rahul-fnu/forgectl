# Phase 4: Agent Session Abstraction - Research

**Researched:** 2026-03-08
**Domain:** Agent session lifecycle, JSON-RPC protocol, TypeScript interface design
**Confidence:** HIGH

## Summary

This phase refactors forgectl's agent invocation layer from direct `invokeAgent()` calls into a unified `AgentSession` interface supporting both one-shot CLI execution (Claude Code, basic Codex) and persistent JSON-RPC subprocess sessions (Codex app-server). The existing code is well-structured for this refactor: `invokeAgent()` in `src/agent/invoke.ts` is a clean function that wraps prompt writing + container exec, and `executeSingleAgent()` in `src/orchestration/single.ts` already separates preparation from execution.

The key technical addition is `AppServerSession` which speaks the Codex app-server JSON-RPC protocol over stdio (newline-delimited JSON). The protocol is well-documented: `initialize` handshake, `thread/start` to create a conversation, `turn/start` to send prompts, with streaming notifications for progress and approval requests. Activity tracking uses a callback-based approach where any output from the agent process triggers an `onActivity` signal.

**Primary recommendation:** Implement AgentSession as a thin lifecycle wrapper that delegates to existing infrastructure (invokeAgent for one-shot, direct JSON-RPC for app-server), keeping the refactor minimal and backward-compatible.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Session result shape: Structured typed result with status enum (`completed | failed | timeout | user_input_required`), includes stdout, stderr, status, tokenUsage, durationMs, turnCount. Token usage always present with zero defaults.
- OneShotSession wraps existing `invokeAgent()` internally — AgentAdapter interface stays, session adds lifecycle on top
- AgentSession interface + factory in new `src/agent/session.ts` — registry.ts stays for adapter lookup, factory uses registry internally
- OneShotSession receives injected Docker container + adapter in constructor — orchestrator manages container lifecycle separately
- Migrate `forgectl run` to use AgentSession too — single code path for all agent invocations
- Spawn codex app-server via Docker exec inside container — consistent with isolation model
- Auto-approve all approval requests — agent is inside isolated container, matches `--yolo` behavior
- Multi-turn: first turn sends full rendered prompt, continuation turns send guidance/error context only
- Direct JSON-RPC handling in AppServerSession — line-delimited JSON on stdio, no separate abstraction layer
- Activity tracking: callback-based `onActivity: () => void`, signal-only with no arguments
- One-shot: any stdout/stderr chunk counts as activity
- `close()` kills the running process; `isAlive()` returns false after close

### Claude's Discretion
- JSON-RPC message framing details (line-delimited vs content-length headers)
- How to map ExecResult exit codes to the status enum
- Internal session state management (tracking invocation state, preventing double-invoke)
- Turn timeout implementation details
- Read timeout for handshake implementation

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| R5.1 | AgentSession interface: invoke/isAlive/close + OneShotSession + AppServerSession + Factory | Interface design patterns, existing adapter/registry code structure |
| R5.2 | One-shot sessions: wrap current CLI pattern, activity tracking on stdout/stderr | Current invokeAgent() code, ExecResult type, execInContainer streaming |
| R5.3 | Persistent sessions: Codex app-server JSON-RPC, handshake, multi-turn, approvals, token usage | Codex app-server protocol documentation, JSONL framing |
| R5.4 | Session lifecycle: per-dispatch creation, activity heartbeat, cleanup on exit | Callback pattern, process kill via Docker exec, state tracking |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| dockerode | ^4.0.2 | Container exec for spawning app-server + one-shot commands | Already in project, all Docker ops go through it |
| vitest | ^2.0.0 | Unit testing session lifecycle and protocol handling | Already in project |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none new) | - | - | All needed libraries already in the project |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Raw JSONL parsing | jayson (JSON-RPC lib) | Unnecessary dependency; Codex protocol omits jsonrpc field and uses custom framing — raw parsing is simpler and more correct |
| WebSocket transport | stdio transport | WebSocket is experimental/unsupported per Codex docs; stdio is the default and stable transport |

**Installation:** No new packages needed.

## Architecture Patterns

### Recommended Project Structure
```
src/agent/
├── types.ts              # AgentAdapter interface (existing, unchanged)
├── claude-code.ts        # Claude Code adapter (existing, unchanged)
├── codex.ts              # Codex adapter (existing, unchanged)
├── invoke.ts             # invokeAgent() (existing, unchanged)
├── registry.ts           # getAgentAdapter() (existing, unchanged)
├── session.ts            # AgentSession interface, AgentResult type, AgentSessionFactory, createAgentSession()
├── oneshot-session.ts    # OneShotSession class
└── appserver-session.ts  # AppServerSession class (Codex JSON-RPC)
```

### Pattern 1: AgentSession Interface
**What:** Unified lifecycle interface wrapping both one-shot and persistent agent modes
**When to use:** All agent invocations — both `forgectl run` and orchestrator dispatch

```typescript
// src/agent/session.ts

export type AgentStatus = "completed" | "failed" | "timeout" | "user_input_required";

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface AgentResult {
  stdout: string;
  stderr: string;
  status: AgentStatus;
  tokenUsage: TokenUsage;
  durationMs: number;
  turnCount: number;
}

export interface AgentSessionOptions {
  onActivity?: () => void;
}

export interface AgentSession {
  invoke(prompt: string, options?: { timeout?: number }): Promise<AgentResult>;
  isAlive(): boolean;
  close(): Promise<void>;
}

export function createAgentSession(
  agentType: string,
  container: Docker.Container,
  agentOptions: AgentOptions,
  env: string[],
  sessionOptions?: AgentSessionOptions,
): AgentSession {
  // Factory: use registry to resolve adapter, then create appropriate session
  if (agentType === "codex" && isAppServerEnabled(agentOptions)) {
    return new AppServerSession(container, agentOptions, env, sessionOptions);
  }
  const adapter = getAgentAdapter(agentType);
  return new OneShotSession(container, adapter, agentOptions, env, sessionOptions);
}
```

### Pattern 2: OneShotSession (wrapping existing invokeAgent)
**What:** Wraps current `invokeAgent()` with lifecycle semantics
**When to use:** Claude Code (always), Codex when app-server not configured

```typescript
// src/agent/oneshot-session.ts

export class OneShotSession implements AgentSession {
  private alive = true;
  private readonly container: Docker.Container;
  private readonly adapter: AgentAdapter;
  private readonly agentOptions: AgentOptions;
  private readonly env: string[];
  private readonly onActivity?: () => void;

  constructor(
    container: Docker.Container,
    adapter: AgentAdapter,
    agentOptions: AgentOptions,
    env: string[],
    sessionOptions?: AgentSessionOptions,
  ) {
    this.container = container;
    this.adapter = adapter;
    this.agentOptions = agentOptions;
    this.env = env;
    this.onActivity = sessionOptions?.onActivity;
  }

  async invoke(prompt: string, options?: { timeout?: number }): Promise<AgentResult> {
    if (!this.alive) throw new Error("Session is closed");

    const opts = options?.timeout
      ? { ...this.agentOptions, timeout: options.timeout }
      : this.agentOptions;

    const result = await invokeAgent(
      this.container, this.adapter, prompt, opts, this.env,
    );

    // Activity on any output
    if (this.onActivity && (result.stdout || result.stderr)) {
      this.onActivity();
    }

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      status: mapExitCodeToStatus(result.exitCode),
      tokenUsage: { input: 0, output: 0, total: 0 },
      durationMs: result.durationMs,
      turnCount: 1,
    };
  }

  isAlive(): boolean { return this.alive; }

  async close(): Promise<void> { this.alive = false; }
}
```

### Pattern 3: AppServerSession (Codex JSON-RPC)
**What:** Persistent subprocess speaking Codex app-server JSON-RPC over stdio
**When to use:** Codex when app-server mode is configured

```typescript
// src/agent/appserver-session.ts — key structure

export class AppServerSession implements AgentSession {
  private alive = false;
  private threadId: string | null = null;
  private turnCount = 0;
  private totalTokens: TokenUsage = { input: 0, output: 0, total: 0 };
  private execStream: NodeJS.ReadWriteStream | null = null;
  private lineBuffer = "";
  private pendingRequests = new Map<number, { resolve: Function; reject: Function }>();
  private nextId = 1;

  // Handshake: initialize → initialized → thread/start
  private async handshake(): Promise<void> {
    const result = await this.sendRequest("initialize", {
      clientInfo: { name: "forgectl", title: "forgectl", version: "1.0.0" },
    });
    await this.sendNotification("initialized", {});
    // thread/start with auto-approve
    const threadResult = await this.sendRequest("thread/start", {
      cwd: this.agentOptions.workingDir,
      approvalPolicy: "never",  // auto-approve everything
      sandbox: "dangerFullAccess",  // inside Docker, no sandbox needed
    });
    this.threadId = threadResult.threadId;
    this.alive = true;
  }

  async invoke(prompt: string, options?: { timeout?: number }): Promise<AgentResult> {
    if (!this.alive) {
      // First invocation: spawn app-server and handshake
      await this.spawn();
      await this.handshake();
    }

    this.turnCount++;
    const turnResult = await this.startTurn(prompt, options?.timeout);
    return turnResult;
  }

  private async startTurn(prompt: string, timeout?: number): Promise<AgentResult> {
    // send turn/start, collect notifications until turn/completed
    await this.sendRequest("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: prompt }],
    });
    // Wait for turn/completed notification, collecting stdout from agent messages
    return this.waitForTurnCompletion(timeout);
  }
}
```

### Pattern 4: Activity Tracking via Docker Exec Streaming
**What:** Hook into dockerode's demuxed stream to fire activity callbacks in real-time
**When to use:** OneShotSession needs real-time activity tracking (not just post-completion)

The current `execInContainer` collects all output and returns it at the end. For proper activity tracking, OneShotSession needs either:
1. A streaming variant of `execInContainer` that fires callbacks on each chunk (preferred)
2. Or accept that one-shot activity is only signaled at completion (simpler, acceptable for Phase 4)

**Recommendation:** For Phase 4, signal activity at completion (when result arrives). Real-time streaming can be added in Phase 5 if stall detection needs sub-invocation granularity. The AppServerSession already has real-time activity via JSON-RPC notifications.

### Anti-Patterns to Avoid
- **Modifying AgentAdapter interface:** Session wraps adapters, doesn't replace them. The adapter's `buildShellCommand` stays for one-shot mode.
- **Shared mutable state between sessions:** Each session is independent. No global session registry.
- **Shell-based app-server spawn:** Use `execInContainer` with Docker exec, not `sh -c` wrapping. The app-server is a long-running process inside the container.
- **Blocking on JSON-RPC reads:** Use async line-by-line parsing with timeouts, not synchronous reads.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON-RPC message framing | Custom protocol parser | Simple JSONL line reader | Codex uses newline-delimited JSON with jsonrpc field omitted — standard JSONL parsing with `split("\n")` is all that's needed |
| Docker process management | Custom process spawner | dockerode `container.exec()` with `hijack: true` | Already used throughout the project; gives bidirectional stream for stdin/stdout |
| Exit code to status mapping | Complex state machine | Simple switch statement | Only 4 status values: 0=completed, timeout-specific=timeout, everything else=failed |

## Common Pitfalls

### Pitfall 1: Docker Exec Stream Lifecycle for Long-Running Processes
**What goes wrong:** The app-server is a long-running process inside a Docker exec. Unlike one-shot commands that end, the exec stream stays open indefinitely.
**Why it happens:** `execInContainer()` is designed for finite commands — it resolves the promise on stream `end`. For app-server, the stream never ends naturally.
**How to avoid:** Create a separate streaming exec helper (or use dockerode directly) that returns the raw bidirectional stream instead of collecting output. The session manages its own read/write lifecycle.
**Warning signs:** Promise never resolves, process appears hung.

### Pitfall 2: JSONL Line Buffering
**What goes wrong:** Docker exec stream chunks don't align with JSON message boundaries. A single chunk may contain partial lines or multiple lines.
**Why it happens:** TCP/stdio buffering splits data at arbitrary byte boundaries.
**How to avoid:** Maintain a line buffer. Append each chunk, split on `\n`, parse complete lines, keep any trailing partial line in the buffer.
**Warning signs:** JSON parse errors, missing messages, garbled output.

### Pitfall 3: Approval Request Deadlock
**What goes wrong:** Codex app-server sends `item/commandExecution/requestApproval` and blocks until the client responds. If the client doesn't respond, the turn hangs forever.
**Why it happens:** The approval is a server-initiated request (has an `id` field) that requires a response — it's not a notification.
**How to avoid:** In the notification/message handler, detect approval request methods and immediately respond with `{ "id": <request_id>, "result": { "decision": "accept" } }`. The `approvalPolicy: "never"` on thread/start should prevent most approvals, but handle the edge case.
**Warning signs:** Turn appears stalled, no further events after `requestApproval`.

### Pitfall 4: Session State After Close
**What goes wrong:** Calling `invoke()` after `close()` or calling `close()` during an active `invoke()`.
**Why it happens:** Concurrent usage without state guards.
**How to avoid:** Track session state (`idle | invoking | closed`). Throw on invoke-after-close. On close-during-invoke, set a flag and reject the pending invocation. Guard against double-close.
**Warning signs:** Zombie processes, unhandled promise rejections.

### Pitfall 5: Codex App-Server Not Installed in Container
**What goes wrong:** The container image may not have `codex` installed, or it may be an older version without `app-server` support.
**Why it happens:** The base image or container setup doesn't include Codex CLI.
**How to avoid:** AppServerSession should attempt to spawn `codex app-server` and handle the failure gracefully (fall back to one-shot or throw a clear error). The factory should ideally check availability before creating an AppServerSession.
**Warning signs:** Exec fails with "command not found" or exits immediately.

## Code Examples

### Exit Code to Status Mapping
```typescript
function mapExitCodeToStatus(exitCode: number): AgentStatus {
  if (exitCode === 0) return "completed";
  // Exit code 124 is the conventional timeout exit code (from `timeout` command)
  // Docker exec timeout in our code throws an Error, not a specific exit code
  // So timeout status is set by the caller when catching timeout errors
  return "failed";
}
```

### JSONL Line Reader for Docker Exec Stream
```typescript
class JsonLineReader {
  private buffer = "";

  feed(chunk: string): object[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // Keep incomplete last line in buffer
    this.buffer = lines.pop() ?? "";

    const messages: object[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed));
      } catch {
        // Log and skip malformed lines (e.g., Rust log output on stderr)
      }
    }
    return messages;
  }
}
```

### Docker Exec for Long-Running Process (Bidirectional Stream)
```typescript
async function startLongRunningExec(
  container: Docker.Container,
  cmd: string[],
  options?: { env?: string[]; workingDir?: string },
): Promise<{ stream: NodeJS.ReadWriteStream; exec: Docker.Exec }> {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Env: options?.env,
    WorkingDir: options?.workingDir,
  });

  const stream = await exec.start({ hijack: true, stdin: true });
  return { stream, exec };
}
```

### Sending JSON-RPC Messages
```typescript
// Codex app-server omits the jsonrpc field
function sendRequest(stream: NodeJS.WritableStream, id: number, method: string, params: object): void {
  const msg = JSON.stringify({ method, id, params });
  stream.write(msg + "\n");
}

function sendNotification(stream: NodeJS.WritableStream, method: string, params: object): void {
  const msg = JSON.stringify({ method, params });
  stream.write(msg + "\n");
}

function sendResponse(stream: NodeJS.WritableStream, id: number, result: object): void {
  const msg = JSON.stringify({ id, result });
  stream.write(msg + "\n");
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `codex exec` one-shot only | `codex app-server` persistent JSON-RPC | Late 2025 | Enables multi-turn, token tracking, persistent threads |
| Each invocation = new process | Session-based with thread reuse | Late 2025 | Saves context window, enables continuation turns |
| No token usage tracking | `thread/tokenUsage/updated` notifications | 2025-2026 | Enables cost tracking per issue |

**Key protocol note:** The Codex app-server JSON-RPC intentionally omits the `"jsonrpc": "2.0"` field from messages. Messages use `method`, `id`, and `params` directly.

## Open Questions

1. **App-server availability detection**
   - What we know: `codex app-server` is a subcommand of the Codex CLI binary
   - What's unclear: Best way to detect if the container's Codex version supports app-server (version check vs. attempting spawn)
   - Recommendation: Attempt spawn, handle failure gracefully with clear error message

2. **Token usage in one-shot mode**
   - What we know: Claude Code and `codex exec` don't report token usage to stdout in a structured way
   - What's unclear: Whether any output parsing could extract token counts
   - Recommendation: Return zero defaults for one-shot mode (per locked decision). Token tracking is an app-server benefit.

3. **Docker exec stream demuxing for bidirectional communication**
   - What we know: dockerode's `hijack: true` gives a raw multiplexed stream. With `Tty: false`, stdout and stderr are multiplexed per Docker's stream protocol (8-byte header per frame).
   - What's unclear: Whether `docker.modem.demuxStream` works for bidirectional (stdin+stdout) hijacked streams, or if we need raw frame handling
   - Recommendation: Test with `AttachStdin: true, hijack: true`. The stream should be writable for stdin and readable for stdout. Use `demuxStream` for reading, `stream.write()` for writing.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^2.0.0 |
| Config file | vitest.config.ts (or package.json vitest section) |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/session.test.ts` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| R5.1 | AgentSession interface + factory creates correct session type | unit | `npx vitest run test/unit/session.test.ts -t "factory"` | No — Wave 0 |
| R5.1 | AgentResult has correct shape with zero-default tokenUsage | unit | `npx vitest run test/unit/session.test.ts -t "result"` | No — Wave 0 |
| R5.2 | OneShotSession wraps invokeAgent, returns AgentResult | unit | `npx vitest run test/unit/session.test.ts -t "oneshot"` | No — Wave 0 |
| R5.2 | OneShotSession activity callback fires on output | unit | `npx vitest run test/unit/session.test.ts -t "activity"` | No — Wave 0 |
| R5.2 | OneShotSession backward compat with existing agent flow | unit | `npx vitest run test/unit/session.test.ts -t "backward"` | No — Wave 0 |
| R5.3 | AppServerSession JSON-RPC handshake | unit | `npx vitest run test/unit/appserver-session.test.ts -t "handshake"` | No — Wave 0 |
| R5.3 | AppServerSession turn lifecycle (start → complete) | unit | `npx vitest run test/unit/appserver-session.test.ts -t "turn"` | No — Wave 0 |
| R5.3 | AppServerSession auto-approves approval requests | unit | `npx vitest run test/unit/appserver-session.test.ts -t "approval"` | No — Wave 0 |
| R5.3 | AppServerSession multi-turn reuses thread | unit | `npx vitest run test/unit/appserver-session.test.ts -t "multi-turn"` | No — Wave 0 |
| R5.3 | AppServerSession token usage tracking | unit | `npx vitest run test/unit/appserver-session.test.ts -t "token"` | No — Wave 0 |
| R5.4 | Session isAlive/close lifecycle | unit | `npx vitest run test/unit/session.test.ts -t "lifecycle"` | No — Wave 0 |
| R5.4 | Invoke after close throws | unit | `npx vitest run test/unit/session.test.ts -t "closed"` | No — Wave 0 |
| R5.4 | Activity callback called on agent output | unit | `npx vitest run test/unit/session.test.ts -t "heartbeat"` | No — Wave 0 |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/session.test.ts test/unit/appserver-session.test.ts`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/session.test.ts` — covers R5.1, R5.2, R5.4 (OneShotSession, factory, lifecycle)
- [ ] `test/unit/appserver-session.test.ts` — covers R5.3 (JSON-RPC protocol, handshake, turns)
- [ ] Mock helpers for Docker container exec stream (bidirectional stream mock)

## Sources

### Primary (HIGH confidence)
- Existing codebase: `src/agent/types.ts`, `src/agent/invoke.ts`, `src/agent/registry.ts`, `src/container/runner.ts`, `src/orchestration/single.ts`
- [Codex App Server official docs](https://developers.openai.com/codex/app-server/) — JSON-RPC protocol spec, handshake, thread/turn lifecycle
- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) — initialize handshake JSON examples, thread/start params, approval format

### Secondary (MEDIUM confidence)
- [OpenAI blog: Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/) — architectural context
- [InfoQ: Codex App Server Architecture](https://www.infoq.com/news/2026/02/opanai-codex-app-server/) — protocol design rationale

### Tertiary (LOW confidence)
- Token usage notification format details (inferred from `thread/tokenUsage/updated` method name, exact payload shape not verified)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies, wrapping existing code
- Architecture: HIGH — interface pattern is well-understood, existing code is clean to wrap
- JSON-RPC protocol: MEDIUM — official docs verified core flow, but exact notification payloads for token usage need runtime validation
- Pitfalls: HIGH — Docker exec streaming, JSONL buffering, and approval handling are well-known patterns

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (stable — Codex app-server protocol is versioned)
