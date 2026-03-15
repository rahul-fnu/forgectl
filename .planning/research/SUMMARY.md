# Project Research Summary

**Project:** forgectl v5.0 — Intelligent Decomposition
**Domain:** LLM-driven task decomposition, worktree runtimes, rate limit resilience, run outcome learning
**Researched:** 2026-03-14
**Confidence:** HIGH (core features), MEDIUM (sqlite-vec, outcome learning heuristics)

## Executive Summary

forgectl v5.0 adds four independent capabilities to an already-mature (v3.0) AI agent orchestrator: LLM-driven task decomposition, a lightweight worktree runtime for parallel sub-task execution, rate-limit-aware retry scheduling, and a run outcome learning system. Research confirms that all four capabilities are well-understood in the industry — real-world precedents exist in ComposioHQ/agent-orchestrator (worktree-per-task, CI-gated dispatch), greyhaven-ai/autocontext (outcome learning with curator-based lesson curation), and clash-sh/clash (git merge-tree conflict detection). The recommended approach is additive-only: every new feature wires into existing orchestrator subsystems (pipeline DAG, governance approval state machine, flight recorder, workspace manager, SQLite/Drizzle) without replacing them. The architecture research identifies a natural 5-phase build order with a dependency-driven sequence: storage schema first, then rate limit retry and outcome learner in parallel, then worktree runtime, then decomposition engine last.

The central risk is scope creep through bad defaults. Each feature independently carries a "looks done but isn't" failure mode: decomposition without semantic plan validation, worktrees without crash-safe cleanup, rate limit detection misclassifying context-window overflows, and outcome lessons accumulating noise faster than signal. The mitigation in every case is the same: gate behind explicit opt-in configuration, maintain the single-agent path as default, and require N-failure confirmation before treating any signal as persistent. The existing governance and workspace-preservation infrastructure largely handles these risks if wired correctly — the new code is smaller than it appears because so much of the required infrastructure already exists.

The one area with meaningful uncertainty is sqlite-vec: the library is actively maintained and has documented Node.js integration, but the exact npm package name and platform binary availability for linux-x64 should be verified before pinning in package.json. The FTS5 fallback (already in SQLite) provides a graceful degradation path if the extension is unavailable.

## Key Findings

### Recommended Stack

The existing stack (TypeScript, Node.js 20+, Fastify, Drizzle ORM, better-sqlite3, @octokit/app, Vitest, tsup) requires no changes. v5.0 adds five targeted dependencies. The `@anthropic-ai/sdk` is used directly for both the decomposition LLM call (via `betaZodTool` for structured JSON output) and text embeddings for outcome learning — no LangChain, no Vercel AI SDK, no instructor-ai. `simple-git` wraps git worktree operations via `.raw()` calls (no high-level worktree API exists in v3.27). `execa` replaces `child_process.spawn` for agent process management with typed errors, timeout enforcement, and automatic cleanup. `p-queue` manages parallel sub-task concurrency with pause/resume for re-plan interruptions. `sqlite-vec` adds K-nearest-neighbor vector search inside the existing SQLite database for semantic lesson retrieval.

**Core technologies:**
- `@anthropic-ai/sdk ^0.78.0`: LLM decomposition calls + text embeddings — official SDK with `betaZodTool` for schema-enforced JSON output; `Anthropic.RateLimitError` carries parsed `retryAfter` field
- `execa ^9.6.0`: process spawning for worktree agents — typed errors, SIGTERM/SIGKILL cleanup, ESM-native; required for daemon-managed process lifecycle
- `simple-git ^3.27.0`: git worktree lifecycle (add, list, remove, prune) via `.raw()` — bundled TypeScript types, no viable alternative
- `p-queue ^9.1.0`: bounded parallel sub-task queue with pause/resume/priority — necessary for re-plan interruption of in-flight tasks
- `sqlite-vec` (verify package name at install): K-NN cosine similarity inside existing SQLite connection — zero additional infrastructure

### Expected Features

Research confirms a clear P1/P2/P3 priority split. Everything required to make "intelligent decomposition" coherent is P1; everything that compounds on that foundation is P2; multi-role curator loops are P3/v6+.

**Must have (v5.0 core — P1):**
- LLM planner with structured JSON output (`{id, title, description, files_hint[], depends_on[]}`) — without this, the milestone does not exist
- Decomposition quality scoring (cycle detection + node count bounds + file-scope overlap) — prevents pathological plans before any agent runs
- Human approval gate with single-agent fallback — integrates with existing governance; decline = fallback, not failure
- Worktree runtime: git worktree add/remove, process-based agent spawn, sub-1s startup vs 2-30s Docker overhead
- Parallel sub-task execution with branch-per-node and topological merge ordering
- Rate limit detection + scheduled retry: 429 + `Retry-After` parsing, workspace suspension, slot back-pressure
- Re-plan vs re-execute on sub-task failure: planner must be callable mid-run with failure context

**Should have (v5.x — P2):**
- Early merge conflict detection via `git merge-tree` dry-run across active worktrees (requires stable worktree runtime)
- Run outcome learning (basic): structured lesson append post-run; top-5 relevant lessons injected into future prompts scoped by repo + label
- Dead-end detection: 3+ failures on same approach/file set = approach-level dead end with TTL

**Defer (v6+ — P3):**
- Full autocontext-style curator loop (Competitor/Analyst/Coach/Curator roles) — requires accumulated lesson corpus first
- Cross-run playbook promotion with human review — defer until lesson volume warrants the UX investment

### Architecture Approach

All four v5.0 features are additive to the existing orchestrator architecture. Four new directories are created (`src/decomposition/`, `src/worktree/`, `src/rate-limit/`, `src/learning/`) and six existing files are modified (`worker.ts`, `dispatcher.ts`, `retry.ts`, `prompt.ts`, `schema.ts`, `config/schema.ts`). Three new SQLite tables extend the existing schema without touching existing columns: `decomposition_plans` (audit + re-planning), `rate_limit_retries` (crash-safe timer recovery), and `outcome_lessons` (scoped lesson store). The decomposition engine runs in a Docker container for the analysis pass (codebase access, full isolation), then approved sub-tasks execute in git worktrees (trusted context, 500ms startup). New components follow the optional dependency injection pattern established for `SubIssueCache` and `governance` — backward compatibility is preserved by design.

**Major components:**
1. **Decomposition Engine** (`src/decomposition/`) — LLM call inside Docker container → Zod-validated DAG JSON → quality scoring → approval gate → emit `PipelineNode[]` to worktree runtime or fallback
2. **Worktree Runtime** (`src/worktree/`) — git worktree lifecycle, execa-based agent spawn, topological layer execution, `git merge-tree` conflict detection, cleanup in try/finally
3. **Rate Limit Retry Scheduler** (`src/rate-limit/`) — classify agent result (HTTP 429 vs other errors), preserve workspace with git checkpoint commit, schedule durable resume, restore timers on daemon restart
4. **Outcome Learner** (`src/learning/`) — fire-and-forget lesson recording post-run, repo+label-scoped retrieval, 500-token injection cap, contradiction flagging

### Critical Pitfalls

1. **Structurally valid but semantically bad decomposition plans** — structural validation (cycles, schema) passes but two nodes claim the same files, a test node has no implementation dependency, or the plan is a single node (the original issue repackaged). Prevent with a semantic validation pass: file-scope overlap detection, orphaned-test-node detection, node-count bounds check. Quality score gates auto-approve vs human review.

2. **Partial plan failure leaves repo in incoherent state** — 3 of 5 nodes succeed, 2 fail; successful branches accumulate while failed ones stall; merging them produces non-compiling output. Prevent by defining the partial-failure strategy upfront before parallel execution ships: stop on first failure and re-plan, or roll back to single-agent. The fallback path must be tested and reliable before any decomposed plan executes in production.

3. **Orphaned worktrees on bootstrap failure** — `git worktree add` succeeds, then any subsequent step fails; the worktree directory is registered in git's internal state but no cleanup fires. Prevent with mandatory try/finally cleanup, `git worktree prune` on daemon startup, SQLite tracking of all active worktree paths, and a maximum worktree count guard. This exact failure mode has occurred in production in the opencode project.

4. **Rate limit misclassification** — "context length limit exceeded" and "rate limit exceeded" share surface-level string similarity; classifying context errors as rate limits creates infinite retry loops that never resolve. Prevent by classifying on HTTP status code first (429 = rate limit, 400/422 = client error); text pattern matching is fallback only. Rate limit retries use a separate counter from `max_retries`.

5. **Outcome learning noise accumulates faster than signal** — after 50+ runs, the lesson store contains contradictory, stale, and non-generalizable lessons; injecting all of them degrades agent behavior. Prevent with a hard 500-token injection cap, repo+label scope filtering, contradiction detection on insertion, and 60-day lesson TTL. Never auto-inject all lessons — use retrieval (top-N by relevance), not broadcast.

## Implications for Roadmap

Based on the architecture research's explicit build order and the pitfall-to-phase mapping, a 5-phase structure is strongly recommended:

### Phase 1: Storage Schema Foundation
**Rationale:** All four new components read from or write to new SQLite tables. Building schema and repositories first with no behavior change means phases 2-5 don't need to also manage schema migration concerns. This is the dependency for everything else.
**Delivers:** Three new Drizzle tables (`decomposition_plans`, `rate_limit_retries`, `outcome_lessons`) + typed repository functions for each. Zero behavior change to existing code paths.
**Addresses:** Storage requirements from all four new features before behavioral code lands
**Avoids:** Schema churn when multiple features land simultaneously; tests existing migration infrastructure under the new tables before behavioral code depends on them

### Phase 2: Rate Limit Retry Scheduler
**Rationale:** Lowest implementation complexity of the four new components; delivers immediate user value (fewer failed runs before decomposition exists); exercises the storage extension pattern with real usage before the harder features land. Can proceed in parallel with Phase 3.
**Delivers:** `src/rate-limit/` (detector, scheduler, types); modified `worker.ts`, `dispatcher.ts`, `retry.ts`; durable timer recovery on daemon restart; workspace preservation via checkpoint git commit before suspension
**Uses:** `@anthropic-ai/sdk` `RateLimitError` typed error class; `rate_limit_retries` table from Phase 1
**Implements:** Rate Limit Retry Scheduler component
**Avoids pitfalls:** Rate limit misclassification (HTTP-status-first classifier); partial-workspace corruption (checkpoint commit before suspension); retry budget burn (separate `rateLimitAttempts` counter)

### Phase 3: Outcome Learner
**Rationale:** Additive subscriber pattern with low coupling to other phases. Lessons accumulate over time — the earlier this is built, the more run history it captures before decomposition is added. Can proceed in parallel with Phase 2.
**Delivers:** `src/learning/` (learner, classifier, formatter, types); `dispatcher.ts` fire-and-forget record call; `prompt.ts` lesson injection; `forgectl outcomes review` command stub
**Uses:** `outcome_lessons` table from Phase 1; existing flight recorder events as raw input signal
**Implements:** Outcome Learner component
**Avoids pitfalls:** Lesson noise accumulation (500-token cap, scope filtering, TTL, contradiction detection); lesson scope contamination (repo+label scoped queries, never global broadcast)

### Phase 4: Worktree Runtime
**Rationale:** Decomposition Engine (Phase 5) requires a working worktree runtime to execute approved plans. Worktree is medium-high complexity and has the most critical safety concerns (cleanup on failure, security boundary). It must be independently stable before the decomposition engine depends on it.
**Delivers:** `src/worktree/` (manager, executor, merger, scheduler); git worktree lifecycle; execa-based agent spawn; `git merge-tree` dry-run conflict detection; topological layer execution; startup prune
**Uses:** `simple-git ^3.27.0`, `execa ^9.6.0`, `p-queue ^9.1.0`; existing pipeline DAG `topologicalSort()`; existing workspace manager path sanitization
**Implements:** Worktree Runtime component
**Avoids pitfalls:** Orphaned worktrees (try/finally cleanup, startup prune, SQLite tracking); security boundary (stripped env vars, workspace path containment via existing WorkspaceManager); bootstrap failure (cleanupFailedWorktree helper)

### Phase 5: Decomposition Engine
**Rationale:** Highest complexity; depends on Phase 4 (worktree runtime) for parallel execution of approved plans. Must not be wired as middleware on the default dispatch path — single-agent remains the default throughout. Builds on the full foundation established in Phases 1-4.
**Delivers:** `src/decomposition/` (engine, prompt, validator, approval, fallback, types); `worker.ts` decomposition detection; structural + semantic DAG validation; quality scoring; human approval gate via existing governance; `FORGECTL_SKIP_DECOMPOSITION` escape hatch
**Uses:** `@anthropic-ai/sdk` `betaZodTool` for schema-enforced LLM output; existing `detectIssueCycles()` from `src/tracker/sub-issue-dag.ts`; existing `enterPendingApproval()` from `src/governance/`
**Implements:** Decomposition Engine component
**Avoids pitfalls:** Bad plan execution (semantic validation pass before approval gate); single-agent path breakage (decomposition is opt-in by label/config, never middleware); partial failure with no fallback (fallback-to-single-agent path required before parallel execution ships)

### Phase Ordering Rationale

- **Schema first** because all four features share the same storage layer; landing schema once avoids parallel schema changes conflicting across feature branches.
- **Rate limit retry and outcome learner can parallelize** — they touch different code paths (worker error handling vs dispatcher completion hook) with no shared new code.
- **Worktree before decomposition** because decomposition has no value without a working parallel execution backend; shipping decomposition engine without worktree runtime produces approval confirmations with nowhere to go.
- **Decomposition last** to allow all supporting infrastructure to be independently tested and used in production before the most complex orchestration layer is added on top.
- **P2 features (conflict detection, full sqlite-vec RAG, dead-end detection) after v5.0 ships** — once Phase 4 worktree runtime is proven stable and Phase 3 lesson store has meaningful data to retrieve from.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 4 (Worktree Runtime):** The security model for "trusted" worktree execution needs precise definition before implementation — what OS-level isolation (namespaces, capability dropping, env stripping) is used below Docker's level? The pitfalls research identifies credential exposure via inherited `process.env` as a critical risk but does not specify the exact mitigations to use.
- **Phase 5 (Decomposition Engine):** The decomposition prompt template is the highest-leverage artifact in the entire feature. Prompt engineering for structured DAG output across diverse real-world issue types is not covered in the research. Budget explicit iteration cycles for the decomposition prompt during Phase 5 planning.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Storage Schema):** Standard Drizzle ORM migration pattern; identical to prior v3.0 schema additions. No novel patterns.
- **Phase 2 (Rate Limit Retry):** HTTP 429 + `Retry-After` handling is fully documented in the official Anthropic SDK and OpenAI rate limit cookbook. The pattern is deterministic and well-tested in production.
- **Phase 3 (Outcome Learner):** Fire-and-forget subscriber pattern directly matches the existing EventRecorder. Schema is fully defined in architecture research.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All dependencies verified against official GitHub repos and npm; version compatibility with Node 20 + ESM confirmed. One caveat: sqlite-vec npm package name requires verification at install time before pinning. |
| Features | MEDIUM-HIGH | P1 features are well-validated against real-world systems (ComposioHQ, opencode). P2/P3 features are directionally clear but less validated in production at this exact scale and integration depth. |
| Architecture | HIGH | Build order is explicitly dependency-driven; all integration points are named against the actual forgectl v3.0 codebase. Component boundaries match established patterns. No existing subsystem needs replacement. |
| Pitfalls | HIGH | Critical pitfalls are sourced from real-world incident reports (opencode bootstrap failure issue, OpenAI Codex orphaned processes), peer-reviewed failure taxonomy (MAST arXiv:2503.13657), and production post-mortems. |

**Overall confidence:** HIGH for v5.0 core scope (Phases 1-5). MEDIUM for P2 features (conflict detection, full semantic dead-end tracking, sqlite-vec RAG).

### Gaps to Address

- **sqlite-vec npm package name:** Verify the exact installable package name against `asg017/sqlite-vec` releases before Phase 3. Use SQLite FTS5 as fallback if binary is unavailable for the target platform (linux-x64).
- **Claude Code exit code taxonomy:** The rate limit classifier in Phase 2 requires a verified mapping of `claude` CLI exit codes and stderr patterns to error types (rate limit vs context overflow vs hard error). Must be tested against real Claude Code output before the classifier ships — not synthetic strings.
- **Decomposition prompt quality:** Phase 5 should budget time for prompt iteration. The first version of the decomposition prompt will likely produce plans that are too coarse or too fine-grained for real-world issues across diverse issue types and repo structures.
- **Worktree security boundary:** Precisely what isolation the worktree runtime provides vs Docker needs to be designed during Phase 4 planning. The exact env-stripping and path-containment implementation is not specified in the research — only the risk is identified.

## Sources

### Primary (HIGH confidence)
- [anthropics/anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript) — `betaZodTool`, `RateLimitError`, streaming
- [@anthropic-ai/sdk on npm](https://www.npmjs.com/package/@anthropic-ai/sdk) — version 0.78.0 verified
- [sindresorhus/execa](https://github.com/sindresorhus/execa) — v9.6.x, ESM-native, typed subprocess lifecycle
- [sindresorhus/p-queue](https://github.com/sindresorhus/p-queue) — v9.1.0, pause/resume/priority/drain
- [steveukx/git-js](https://github.com/steveukx/git-js) — simple-git v3.27, worktree `.raw()` API
- [clash-sh/clash](https://github.com/clash-sh/clash) — `git merge-tree` dry-run for early conflict detection
- [git-merge-tree documentation](https://git-scm.com/docs/git-merge-tree) — three-way merge simulation without side effects
- [OpenCode worktree bootstrap failure issue + fix PR](https://github.com/anomalyco/opencode) — real-world orphaned worktree pattern and cleanupFailedWorktree fix
- [MAST: Multi-Agent System Failure Taxonomy (arXiv:2503.13657)](https://arxiv.org/pdf/2503.13657) — decomposition failure modes, coordination failures
- [TDAG: Dynamic Task Decomposition (arXiv:2402.10178)](https://arxiv.org/abs/2402.10178) — DAG-based sub-agent generation with per-node subagent
- [OpenAI rate limit handling cookbook](https://cookbook.openai.com/examples/how_to_handle_rate_limits) — Retry-After patterns, thundering herd prevention
- forgectl v3.0 source: `src/pipeline/dag.ts`, `src/tracker/sub-issue-dag.ts`, `src/governance/approval.ts` — reuse points confirmed via direct codebase inspection

### Secondary (MEDIUM confidence)
- [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator) — worktree-per-task pattern, CI-gated dispatch, implicit planner
- [greyhaven-ai/autocontext](https://github.com/greyhaven-ai/autocontext) — outcome learning architecture, curator roles, lesson curation pipeline
- [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) — K-NN vector search in SQLite, active 2025 (npm package name requires verification)
- [git worktrees for parallel AI agents (Upsun)](https://devcenter.upsun.com/posts/git-worktrees-for-parallel-ai-coding-agents/) — shared resource pitfalls, cleanup patterns
- [No More Stale Feedback: Co-Evolving Critics (arXiv:2601.06794)](https://arxiv.org/abs/2601.06794) — stale lesson failure mode in agent feedback loops
- [OpenAI Codex orphaned processes issue](https://github.com/openai/codex/issues/11090) — PPID=1 orphaned processes pattern
- [LLM tool-calling rate limits in production](https://medium.com/@komalbaparmar007/llm-tool-calling-in-production-rate-limits-retries-and-the-infinite-loop-failure-mode-you-must-2a1e2a1e84c8) — $1.6M runaway loop case study, rate limit blast radius

### Tertiary (LOW confidence — validate during implementation)
- sqlite-vec Node.js tutorial (DEV Community, 2025) — integration pattern confirmed but package name unverified
- Various 2026 agentic workflow blog posts — directional confirmation of patterns; treat as supporting evidence only

---
*Research completed: 2026-03-14*
*Ready for roadmap: yes*
