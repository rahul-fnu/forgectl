# Stack Research

**Domain:** AI agent orchestrator — intelligent task decomposition, worktree runtimes, rate limit resilience, outcome learning (v5.0)
**Researched:** 2026-03-14
**Confidence:** HIGH (core additions), MEDIUM (vector similarity via sqlite-vec)

## Context: New Additions Only

The existing stack is validated and not re-researched here. This document covers only what v5.0 adds.

**Already in place (do not re-add):** TypeScript, Node.js 20+, Commander, Fastify 5, Dockerode, Zod, Vitest, tsup, Drizzle ORM, better-sqlite3, @octokit/app, @octokit/webhooks, @octokit/rest, picomatch, keytar, chalk, js-yaml, agent-relay.

---

## Recommended Stack Additions

### Core New Dependencies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `@anthropic-ai/sdk` | `^0.78.0` | LLM API calls for task decomposition — send issue content, receive structured DAG output | Official SDK with built-in retry, streaming, and typed tool-use helpers including `betaZodTool`. Already the API that Claude Code wraps; calling it directly allows structured message calls with Zod-schema-enforced responses without shelling out to `claude -p`. Throws typed `RateLimitError` with a parsed `retryAfter` field — exactly what the rate limit retry path needs. |
| `execa` | `^9.6.0` | Lightweight process spawning for worktree agents (no Docker overhead) | Purpose-built for programmatic process execution. Typed Promise-based API, streaming stdio, graceful kill with SIGTERM→SIGKILL, configurable timeout, and IPC. Replaces raw `child_process.spawn` for agent invocations that run inside a git worktree rather than a container. Execa 9 is fully ESM-native — matches forgectl's `"type": "module"` project type. |
| `simple-git` | `^3.27.0` | Programmatic git worktree management (add, list, remove, prune) | Typed wrapper around the git CLI with bundled TypeScript definitions (no `@types/` package needed). v3 is dual CJS+ESM. The `.raw()` escape hatch gives access to any worktree subcommand not yet in the high-level API. 6.4M weekly downloads, actively maintained. |
| `p-queue` | `^9.1.0` | Priority queue for parallel sub-task execution with dynamic concurrency cap | Required for worktree-runtime sub-tasks that arrive dynamically and must be bounded. Unlike `p-limit` (which just gates concurrent invocations), `p-queue` supports priority ordering, pause/resume, and draining — all needed for the decomposition feedback loop where a re-plan must interrupt and replace in-flight tasks. Pure ESM, compatible with forgectl's module type. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `p-limit` | `^7.3.0` | Simple concurrency cap for bounded fan-out operations | Use for one-shot bounded parallel calls where ordering does not matter and no queue state is needed — e.g., validating multiple sub-task outputs simultaneously or running decomposition pre-checks in parallel. Lighter than p-queue for these cases. Pure ESM. |
| `sqlite-vec` | latest (verify at install) | K-nearest-neighbor vector similarity search inside the existing SQLite database | Required for outcome learning: embed the current issue text, find the semantically nearest past lessons, inject them into the decomposer's system prompt. Runs as a SQLite loadable extension via `db.loadExtension()` on the existing better-sqlite3 connection — no new service, no new database. Pure C, SIMD-accelerated cosine similarity. Active 2025 development. |

### Development Tools

No new dev tools are needed. Existing tsup, vitest, eslint, prettier, and drizzle-kit cover all new v5.0 code.

---

## Installation

```bash
# New runtime dependencies for v5.0
npm install @anthropic-ai/sdk execa simple-git p-queue p-limit

# sqlite-vec for outcome learning
# Verify the current npm package name — canonical upstream is asg017/sqlite-vec
npm install sqlite-vec
```

---

## Feature-to-Library Mapping

### LLM-Driven Task Decomposition

**Use:** `@anthropic-ai/sdk` + existing `zod`

Decomposition calls Claude directly via `anthropic.messages.create()` with a tool definition whose `inputSchema` is a Zod schema matching the DAG YAML structure. Claude is forced into the tool response shape — the response is always parseable, no freeform JSON extraction or regex needed. The existing Zod validation layer then validates the DAG before it enters the pipeline executor.

The SDK's built-in retry (3 attempts, exponential backoff) handles transient API errors automatically. Rate limit responses surface as `Anthropic.RateLimitError` (HTTP 429) with a `retryAfter` field already parsed to seconds — wire directly into the orchestrator's existing retry queue.

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

const decomposeTool = betaZodTool({
  name: 'decompose_issue',
  description: 'Break the issue into a DAG of focused sub-tasks',
  inputSchema: z.object({
    nodes: z.array(z.object({
      id: z.string(),
      title: z.string(),
      depends_on: z.array(z.string()),
    })),
  }),
  run: async (input) => input, // return parsed structure directly
});
```

**Do NOT use:** LangChain, LlamaIndex, or instructor-ai. The Anthropic SDK's `betaZodTool` provides structured output natively for a single-provider use case. Adding a framework creates an additional update dependency with no benefit.

### Git Worktree Management

**Use:** `simple-git`

```typescript
import simpleGit from 'simple-git';
const git = simpleGit(repoRoot);

// Add a worktree for a sub-task branch
await git.raw(['worktree', 'add', worktreePath, branchName]);

// List all active worktrees (porcelain for machine-readable output)
await git.raw(['worktree', 'list', '--porcelain']);

// Remove when sub-task completes
await git.raw(['worktree', 'remove', '--force', worktreePath]);

// Prune stale metadata after crash recovery
await git.raw(['worktree', 'prune']);
```

Use `.raw()` for all worktree operations — simple-git v3.27 does not yet have a high-level `worktree()` API, but the raw command path is stable and typed. The `WorktreeManager` module in `src/worktree/` wraps these calls and adds per-worktree path locking via a SQLite row to prevent two agents colliding on the same directory.

**Do NOT use:** `git-worktree` npm package (alexweininger — last updated 2022, negligible downloads) or `nodegit` (libgit2 native bindings — heavy native build dependency, overkill for what is purely CLI-passthrough work).

### Lightweight Process Spawning (Worktree Agents)

**Use:** `execa`

```typescript
import { execa } from 'execa';

const proc = execa('claude', ['-p', prompt], {
  cwd: worktreePath,
  env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
  stdout: 'pipe',
  stderr: 'pipe',
  timeout: timeoutMs,
});

// Stream output in real time
proc.stdout?.on('data', (chunk) => logger.info(chunk.toString()));
const result = await proc;
// result.exitCode, result.stdout, result.stderr — all typed
```

Execa 9's structured subprocess object exposes stdout/stderr as separate streams, exit code, signal name, and wall-clock duration — all typed. The `timeout` option sends SIGTERM then SIGKILL, preventing orphaned agent processes if the daemon restarts.

**Rate limit detection in process mode:** Claude Code exits with code 1 and writes a structured JSON error to stderr when rate-limited: `{"type":"error","error":{"type":"rate_limit_error","retry_after":N}}`. Use `stderr: 'pipe'` and accumulate the stderr buffer for parsing on process exit. Map the `retry_after` value to the same orchestrator retry queue used for API-mode rate limits.

**Do NOT use:** Raw `child_process.spawn`. Execa provides typed errors, automatic cleanup on parent exit, and IPC — all required for reliable agent lifecycle management in a daemon context.

### Parallel Sub-Task Execution

**Use:** `p-queue` (dynamic task queue for worktree agents) + `p-limit` (bounded fan-out for simpler parallel checks)

```typescript
import PQueue from 'p-queue';
const queue = new PQueue({ concurrency: maxWorktrees });

// Enqueue sub-tasks from the decomposition DAG
for (const node of dagNodes) {
  queue.add(() => runWorktreeAgent(node), { priority: node.depth });
}

// Wait for all to complete before synthesizing
await queue.onIdle();
```

`p-queue`'s `pause()` and `clear()` methods support the re-plan path: when the feedback loop decides to re-decompose, pause the queue, clear pending tasks, and enqueue the revised plan. `p-limit` handles simpler cases — like running up to N validation checks in parallel — without the overhead of a full queue.

Both packages are pure ESM. Import as `import PQueue from 'p-queue'` and `import pLimit from 'p-limit'`. Compatible with forgectl's `"type": "module"` package.

### Rate Limit Detection and Scheduled Retry

**Use:** `@anthropic-ai/sdk` typed error classes + existing orchestrator retry queue

The SDK throws `Anthropic.RateLimitError` (extends `APIError`) on HTTP 429. The error carries:
- `status: 429`
- `headers`: raw response headers including `retry-after` and `anthropic-ratelimit-*`
- `retryAfter`: already parsed to an integer (seconds)

```typescript
import Anthropic from '@anthropic-ai/sdk';

try {
  await anthropic.messages.create({ ... });
} catch (e) {
  if (e instanceof Anthropic.RateLimitError) {
    const waitMs = (e.retryAfter ?? 60) * 1000;
    // Schedule retry in existing orchestrator retry queue, preserving workspace/checkpoint
    await orchestrator.scheduleRetry(issueId, waitMs, currentCheckpoint);
  }
}
```

For process-spawned agents (execa path), parse the accumulated stderr for the JSON rate limit error and map to the same `scheduleRetry` call.

**Do NOT add:** `bottleneck`, `rate-limiter-flexible`, or any third-party rate limiting library. The retry logic belongs in the existing orchestrator state machine. A separate library creates two competing retry systems and duplicates state.

### Run Outcome Learning

**Use:** `sqlite-vec` + existing `better-sqlite3` + `@anthropic-ai/sdk` (for text embeddings via `embeddings.create()`)

Three table additions to the existing Drizzle ORM schema:

1. `outcome_lessons` — text lessons extracted from completed runs (issue summary, what worked, dead ends, final sub-task count)
2. `outcome_embeddings` — serialized float32 vectors, one per lesson, generated by the Anthropic embeddings API
3. `vec_lessons` — sqlite-vec virtual table for KNN search over the embeddings

At dispatch time: embed the incoming issue title + body, query `vec_lessons` for the top-5 nearest neighbors (cosine similarity), inject the retrieved lesson texts into the decomposer's system prompt as historical context.

```typescript
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

// Load into existing connection (no new database)
sqliteVec.load(db);

// K-nearest neighbor query at dispatch time
const similar = db.prepare(`
  SELECT l.lesson_text, v.distance
  FROM vec_lessons v
  JOIN outcome_lessons l ON l.id = v.rowid
  WHERE v.embedding MATCH ?
  ORDER BY v.distance
  LIMIT 5
`).all(new Float32Array(queryVector));
```

**Fallback when embeddings are not yet seeded:** BM25 full-text search via SQLite FTS5 on `outcome_lessons.issue_label` and `lesson_text` columns. FTS5 is already available in SQLite with no extra extension — keyword-based retrieval degrades gracefully until the vector index is populated.

**Confidence on sqlite-vec: MEDIUM.** The library is actively maintained, has Node.js tutorials from early 2025, and ships pre-built platform binaries to npm. However, the exact npm package name and binary availability for the target platform (linux-x64) should be verified at install time. The canonical upstream is `asg017/sqlite-vec`; check the current npm package name before pinning in package.json.

**Do NOT use:** External vector databases (Chroma, Pinecone, Qdrant, Weaviate). The project constraint is single-machine, SQLite-only. sqlite-vec runs inside the existing better-sqlite3 connection with zero additional infrastructure.

---

## Alternatives Considered

| Recommended | Alternative | Why Not |
|-------------|-------------|---------|
| `@anthropic-ai/sdk` direct | Shell out to `claude -p` for decomposition | No structured output enforcement; subprocess overhead; no typed error classes for rate limit detection |
| `@anthropic-ai/sdk` direct | `@instructor-ai/instructor` | Extra dependency for what `betaZodTool` already provides in the SDK; adds its own Anthropic adapter layer |
| `@anthropic-ai/sdk` direct | `@ai-sdk/anthropic` (Vercel AI SDK) | Vercel AI SDK adds an abstraction layer designed for multi-provider use — forgectl is Claude-only; the abstraction is unnecessary weight |
| `execa` | Raw `child_process.spawn` | No timeout enforcement, no typed errors, no auto-cleanup on parent exit — all required for daemon-managed agent processes |
| `execa` | `zx` | zx is a shell scripting tool, not a process-embedding library; heavier API surface designed for script authors, not programmatic embedding |
| `simple-git` | `git-worktree` npm package | Last updated 2022, negligible downloads; abandoned |
| `simple-git` | `isomorphic-git` | Pure JS implementation (no git binary required), but git worktrees are a binary-level feature — isomorphic-git has no worktree support |
| `simple-git` | Direct `execa('git', [...])` calls | Possible, but simple-git adds typed return parsing, error wrapping, and the GitConfigScope enum — worth the marginal dependency |
| `p-queue` | `bull` / `bullmq` | Requires Redis; violates the single-process, SQLite-only project constraint |
| `p-queue` | `bee-queue` | Same Redis dependency problem |
| `sqlite-vec` | Separate Chroma service | Adds a Python service dependency; violates single-machine constraint |
| `sqlite-vec` | SQLite FTS5 only | FTS5 is keyword-based, not semantic; misses synonyms and paraphrased lessons — use FTS5 as fallback only, not primary |
| `sqlite-vec` | `sqlite-vss` | Predecessor to sqlite-vec, no longer actively maintained; sqlite-vec is the designated successor |

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| LangChain / LlamaIndex | Framework-level LLM abstractions conflict with forgectl's handcrafted orchestration; adds its own agent loop and retry logic | `@anthropic-ai/sdk` directly with `betaZodTool` |
| `bottleneck` / `rate-limiter-flexible` | Creates a second retry system alongside the existing orchestrator retry queue; two systems diverge | Handle `Anthropic.RateLimitError` in the existing retry queue |
| `nodegit` | Native libgit2 bindings with heavy build dependency; worktree API incomplete | `simple-git` with `.raw()` |
| `sqlite-vss` | No longer actively maintained; superseded by sqlite-vec | `sqlite-vec` |
| `openai` SDK | No OpenAI usage in scope; adding a second LLM vendor SDK creates version management overhead | `@anthropic-ai/sdk` only |
| `@anthropic-ai/claude-agent-sdk` | This is the Claude Code SDK (for building agents that run inside Claude Code) — not what forgectl needs. forgectl calls the Claude API directly for decomposition. | `@anthropic-ai/sdk` |
| `uuid` | Already covered by Node.js 20+ built-in `crypto.randomUUID()` | Built-in |
| `cron` / `node-cron` | Existing setTimeout-chain scheduler in the orchestrator covers all retry scheduling needs | Existing orchestrator retry queue |

---

## Stack Patterns by Variant

**If sub-task is trusted (same repo, non-destructive):**
- Use execa + git worktree (no Docker)
- Because worktree gives file isolation without container spin-up overhead

**If sub-task is untrusted (external data sources, arbitrary shell commands):**
- Use the existing Dockerode path
- Because a container provides process and filesystem isolation; a worktree alone is not a security boundary

**If issue is simple (single file, well-understood pattern):**
- Skip the decomposition LLM call; dispatch directly to a single agent
- Because LLM decomposition adds latency (~2–5s) and API cost; the single-agent fallback must remain the fast path

**If sqlite-vec binary is unavailable on the target platform:**
- Use SQLite FTS5 full-text search on `outcome_lessons` as fallback
- BM25 keyword retrieval is better than no retrieval; the outcome learning feature degrades gracefully

---

## Version Compatibility

| Package | Node.js Requirement | ESM/CJS | Notes |
|---------|---------------------|---------|-------|
| `@anthropic-ai/sdk@^0.78.0` | Node 18+ | Dual ESM+CJS | Uses built-in `fetch` in Node 18+; no polyfill needed |
| `execa@^9.6.0` | Node 18.19.0 or 20.5.0+ | Pure ESM | forgectl targets Node 20+ — fully compatible |
| `simple-git@^3.27.0` | Node 14+ | CJS + ESM + TS | Bundled typings; no `@types/simple-git` needed |
| `p-queue@^9.1.0` | Node 18+ | Pure ESM | Do not require() it; import only |
| `p-limit@^7.3.0` | Node 18+ | Pure ESM | Same constraint as p-queue |
| `sqlite-vec` | Any (native binaries) | CJS (via better-sqlite3) | Loads as a SQLite extension; platform binary (linux-x64) must be present |

---

## Integration Points with Existing Stack

| Existing | New | Integration |
|----------|-----|-------------|
| `src/pipeline/` DAG executor | `@anthropic-ai/sdk` decomposer | Decomposer outputs a DAG YAML struct; parsed and fed into existing pipeline DAG types |
| `src/orchestrator/` retry queue | `Anthropic.RateLimitError` | Catch in dispatch loop; `retryAfter` maps to existing `scheduleRetry(issueId, waitMs)` |
| `src/storage/` Drizzle schema | sqlite-vec + `outcome_lessons` | New tables added to existing schema.ts; sqlite-vec loaded on the existing better-sqlite3 `db` instance |
| `src/agent/` Claude Code adapter | `execa` | Worktree runtime path uses execa instead of Dockerode; same adapter interface, different spawn mechanism |
| `src/workspace/` WorkspaceManager | `simple-git` WorktreeManager | New `src/worktree/` module manages worktree lifecycle; WorkspaceManager retains Docker-based workspace ownership |
| Existing `p-queue` (if used) | `p-queue@9` | If any prior code used p-queue, confirm it is already on v9 or update; only one version should be present |

---

## Sources

- [anthropics/anthropic-sdk-typescript GitHub](https://github.com/anthropics/anthropic-sdk-typescript) — tool-use helpers, typed error classes, streaming (HIGH confidence)
- [@anthropic-ai/sdk on npm](https://www.npmjs.com/package/@anthropic-ai/sdk) — version 0.78.0 verified (HIGH confidence)
- [sindresorhus/execa GitHub](https://github.com/sindresorhus/execa) — v9.6.x, ESM-native, Node 20 compatible, stdio streaming (HIGH confidence)
- [execa@9.6.1 jsDocs.io](https://www.jsdocs.io/package/execa) — TypeScript types confirmed (HIGH confidence)
- [steveukx/git-js GitHub](https://github.com/steveukx/git-js) — simple-git v3.27, TypeScript bundled, `.raw()` API (HIGH confidence)
- [sindresorhus/p-queue GitHub](https://github.com/sindresorhus/p-queue) — v9.1.0, pure ESM, pause/resume/priority/drain (HIGH confidence)
- [sindresorhus/p-limit GitHub](https://github.com/sindresorhus/p-limit) — v7.3.0, pure ESM (HIGH confidence)
- [asg017/sqlite-vec GitHub](https://github.com/asg017/sqlite-vec) — K-NN, cosine similarity, SQLite extension, active 2025 (MEDIUM confidence — verify npm package name at install time)
- [sqlite-vec Node.js tutorial (DEV Community, 2025)](https://dev.to/stephenc222/how-to-use-sqlite-vec-to-store-and-query-vector-embeddings-58mf) — Node.js integration confirmed (MEDIUM confidence)

---

*Stack research for: forgectl v5.0 Intelligent Decomposition*
*Researched: 2026-03-14*
