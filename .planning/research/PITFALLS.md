# Pitfalls Research

**Domain:** Adding LLM-driven task decomposition, worktree runtimes, rate limit retry, and outcome learning to an existing AI agent orchestrator (forgectl v5.0)
**Researched:** 2026-03-14
**Confidence:** HIGH (decomposition/worktree pitfalls verified via multiple real-world systems; outcome learning pitfalls verified via research literature)

---

## Critical Pitfalls

### Pitfall 1: Decomposition Output That Produces a Valid DAG but a Terrible Plan

**What goes wrong:**
The LLM produces a syntactically valid JSON DAG — it passes cycle detection, all node IDs resolve, dependencies are acyclic — but the plan is wrong. Tasks overlap (two nodes both "refactor auth module"), tasks are too coarse (single node: "implement the entire feature"), tasks are mis-sequenced (a test node depends on nothing rather than on the implementation node), or tasks are hallucinated (a node references a file that doesn't exist in the repo). The orchestrator happily executes the bad plan. Agents work in parallel on the same files, creating conflicts. Or the plan succeeds and the output is wrong.

**Why it happens:**
Structural validation (cycle detection, schema validation) is easy to implement and gives false confidence. Semantic validation — "is this a good plan?" — is much harder and often skipped. Developers focus on the parser and DAG validator and treat the LLM output as correct-if-valid. The existing `pipeline/dag.ts` validates structure but has no concept of plan quality.

**How to avoid:**
- After structural validation, run a semantic validation pass:
  - Detect overlapping file ownership (two nodes claim the same files)
  - Detect implausibly coarse nodes (single node with "implement entire X" in description)
  - Detect orphaned test nodes (test node with no dependency on an implementation node)
  - Verify referenced files exist in the repo (stat check)
- Implement a confidence score: if the LLM decomposition doesn't meet a minimum score, trigger the fallback to single-agent execution
- Always provide the human approval gate for decomposition output before execution — the plan is a hypothesis, not a directive
- Use structured output (JSON schema enforcement) on the decomposition call to eliminate hallucinated node structures; structured output with schema validation eliminates field-level hallucinations but not semantic errors

**Warning signs:**
- Two or more nodes referencing the same file path in their scope
- A "test" node with `depends_on: []`
- Any node whose description contains the phrase "entire", "all", or "the whole"
- Node count that is 1 (the LLM returned a single-node plan, which is just the original task)
- Node count that exceeds the number of distinct files in the issue's scope (over-decomposition)

**Phase to address:** Decomposition Engine phase (core decomposition feature)

---

### Pitfall 2: Bad Plan is Worse Than No Plan

**What goes wrong:**
A single-agent run on a complex issue produces partial output that can be reviewed and corrected. A decomposed plan that executes partially — three nodes succeed, two nodes fail mid-execution — leaves the repo in an incoherent intermediate state. Node A's changes are committed to a branch, Node B's changes conflict with A, Node C never ran. Merging the successful branches produces code that doesn't compile. The user has more cleanup work than if the agent had just attempted the whole thing monolithically.

**Why it happens:**
Decomposition is treated as pure upside. Developers don't design for partial failure. The existing single-agent path has a well-tested retry and rollback story (workspace reuse, output branch). The decomposed path has neither — successful branches accumulate while failed branches stall.

**How to avoid:**
- Design the partial-failure strategy before implementing decomposition: what happens when 3 of 5 nodes succeed?
  - Option A: Commit successful node branches, mark failed nodes for re-plan (re-decompose from remaining work)
  - Option B: Roll back all nodes and fall back to single-agent on the full issue
  - Option C: Stop on first failure, do not execute remaining nodes
- The fallback to single-agent must be reliable, tested, and the **default** when decomposition quality is uncertain
- Never let partial success become permanent state without human acknowledgment — the parent issue should remain open until the full decomposed plan completes or is abandoned
- Implement "decomposition budget": if the estimated total agent cost for the decomposed plan exceeds a threshold, require human approval before proceeding

**Warning signs:**
- Decomposition code with no fallback path to single-agent execution
- `dispatchIssue` invoked for decomposed sub-tasks without a parent-level coordinator tracking overall success
- Branches being created for sub-tasks but no merge strategy defined until after all nodes complete

**Phase to address:** Decomposition Engine phase and Parallel Execution / Merge phase

---

### Pitfall 3: Orphaned Worktrees on Bootstrap Failure

**What goes wrong:**
Worktree creation is not atomic. The sequence: `git worktree add`, `git checkout -b <branch>`, directory setup, agent spawn. If any step fails after `git worktree add` succeeds, the worktree directory is created and registered in Git's internal state but there is no agent running and no cleanup runs. These orphaned worktrees accumulate silently. `git worktree list` shows dozens of stale entries. On next run, `git worktree add` fails because the branch name already exists. Disk space fills from repeated failures. (This exact failure mode was found in the real-world `opencode` project — see Sources.)

**Why it happens:**
Developers write the happy path first: create worktree, proceed. Error handling is added later and often misses early-in-sequence failures. The cleanup code runs after agent completion but not after bootstrap failure. The Node.js process crashing mid-spawn leaves no cleanup code executed.

**How to avoid:**
- Wrap the entire worktree lifecycle in try/finally: if ANY step after `git worktree add` fails, call a `cleanupFailedWorktree` helper that runs `git worktree remove --force <path>` and `git branch -D <branch>` (if branch was created)
- Register cleanup on every failure path explicitly, not just in a top-level catch — async bootstrap failures (deferred steps, `setTimeout(0)`, background promises) will not be caught by a synchronous try/catch
- Run `git worktree prune` on daemon startup to remove stale metadata from previous crash cycles
- Enforce a maximum worktree count: if count exceeds threshold (e.g., 20), refuse to create new ones and alert
- Track all worktree paths in SQLite so a cleanup sweep can recover from crash-without-cleanup scenarios
- Each worktree directory name must be unique per run, not derived from the branch name alone (branch names can collide on retry)

**Warning signs:**
- `git worktree list` output growing over time without corresponding active runs
- "branch already exists" errors on worktree creation
- Disk usage growing between runs without new output files
- Daemon startup not running `git worktree prune`

**Phase to address:** Worktree Runtime phase

---

### Pitfall 4: Parallel Nodes Touching Shared Files Guarantee Merge Conflicts

**What goes wrong:**
The LLM decomposes an issue into parallel nodes but doesn't know which files each node will touch. Node A and Node B both modify `src/config/schema.ts` (adding fields). Both succeed on their individual branches. Merge conflicts are detected only at the merging step, after both agent runs complete. The conflict requires human resolution. If the merge is automated (using `git merge -X ours`), one change silently wins and the other is lost.

**Why it happens:**
Static file ownership is hard to predict before the agents run. The decomposition prompt asks the LLM to estimate scope but LLMs cannot reliably predict which files an agent will touch. Developers assume "parallel is safe" because worktrees are isolated. Isolation prevents runtime conflicts during execution but not logical conflicts at merge time.

**How to avoid:**
- Before marking two nodes as parallelizable, use a pre-flight scope analysis: ask the LLM to list the files each node will likely modify, and flag any overlap as a sequential dependency
- Use `--no-commit` merge strategy for node branches: merge each branch to a staging branch one at a time, check for conflicts after each merge, stop and re-plan if a conflict is detected rather than attempting automated resolution
- Never use `git merge -X ours` or `git merge -X theirs` automatically — losing code silently is worse than failing explicitly
- For files that multiple nodes are likely to touch (schema files, index/barrel files, config files), assign them to a "coordinator" sequential node that runs after the parallel nodes
- Detect merge conflicts and feed the conflict description back to the LLM re-planner: "Node A and Node B both modified schema.ts — re-decompose with an explicit merge coordination node"

**Warning signs:**
- Decomposed nodes all listed as parallel with no sequential dependencies
- Schema files, index files, or configuration files appearing in multiple nodes' estimated scope
- Merge step using automated conflict resolution strategies

**Phase to address:** Parallel Execution / Merge phase

---

### Pitfall 5: Rate Limit Misclassification — Real Errors Treated as Rate Limits

**What goes wrong:**
The rate limit detector sees an agent exit with a non-zero code and an error message containing "limit" (e.g., "token limit exceeded" or "context length limit"). It classifies this as a rate limit and schedules a retry with workspace preservation. The actual error is a context window overflow that will never resolve by waiting. The retry fires 60 seconds later, the agent hits the same context window error, and the cycle continues indefinitely, consuming retries and wasting time.

**Why it happens:**
The string patterns for rate limits are ambiguous. "Rate limit", "limit exceeded", "quota exceeded", "too many requests", and "context limit" share surface-level similarity. The existing `classifyFailure` in `retry.ts` only distinguishes `completed` vs `error`, without further rate-limit sub-classification. Developers add pattern matching quickly and use broad patterns.

**How to avoid:**
- Classify by HTTP status code first (429 is rate limit, 400/422 is client error, 500/503 is server error) — never rely on message text alone
- For Claude Code exit codes: research the actual exit codes vs error message patterns used by the `claude` CLI before implementing detection
- Context window errors are client errors (400 with message containing "context length"), not rate limits — treat them as non-retryable errors, not temporary
- Rate limit retries must have a maximum retry count with explicit handling when the limit is reached (not silent discard)
- Add a rate limit detection confidence level to logged events: HIGH (HTTP 429 with Retry-After header), MEDIUM (HTTP 429 without header), LOW (text pattern match only)
- Test the classifier against a set of real error strings from Claude Code and Codex before using it in production

**Warning signs:**
- Rate limit classification based solely on message text patterns
- No distinction between "context too long" and "rate limited"
- Rate limit retry loops that never terminate
- Retry events appearing every N seconds without any agent making progress

**Phase to address:** Rate Limit Retry phase

---

### Pitfall 6: Workspace Preservation on Rate Limit Loses Partial Work

**What goes wrong:**
An agent is rate limited mid-execution. The system preserves the workspace (correct). But the workspace contains partial file modifications: the agent wrote to 3 of 10 target files before hitting the limit. On retry, the agent starts fresh in the preserved workspace, sees the 3 partially-written files, and either: (a) treats them as complete and skips them (missing the rest), or (b) overwrites them from scratch (correct but wastes the preserved work). In case (a), the output is subtly wrong.

**Why it happens:**
"Preserve workspace" means different things at different granularities. Preserving the directory contents is not the same as preserving a coherent checkpoint. The agent doesn't know which files were written atomically and which were interrupted mid-write. Without commit-level checkpoints in the worktree, the agent has no reliable way to distinguish completed vs incomplete file modifications.

**How to avoid:**
- Before suspending a rate-limited worktree, create a git commit of the current state with a clear message: `[checkpoint: rate-limited at step X]`
- On retry, provide the agent with the commit message and diff of what was committed, so it knows what was completed vs what remains
- Define "workspace preservation" as preserving a committed state, not just file system state — uncommitted partial writes are worse than nothing because they mislead the agent
- If the rate limit occurs before any meaningful work is done (first agent call), consider a clean workspace on retry instead of a partial one

**Warning signs:**
- Rate limit retry that preserves workspace but provides no context to the agent about what was completed
- No git commit created before suspending the workspace
- Agent re-examining all files from scratch on every retry regardless of prior work

**Phase to address:** Rate Limit Retry phase

---

### Pitfall 7: Outcome Learning Accumulates Noise Faster Than Signal

**What goes wrong:**
The outcome learning system records lessons from every run. After 50 runs, the lesson store contains: 12 genuinely useful patterns, 18 observations that were specific to one issue and don't generalize, 11 contradictory lessons (run 12 says "always add tests first", run 37 says "add tests after implementation"), and 9 lessons that are outdated because the codebase changed. The lesson prompt injection grows to 2,000 tokens. The agent's behavior degrades — it follows contradictory rules and ignores more specific context because the general context window is polluted.

**Why it happens:**
It's easy to append lessons; it's hard to curate, weight, and expire them. Systems implement lesson recording in phase 1 and defer curation to "later", which never comes. The real-world failure mode (observed in production agents) is memory files growing to 6,000+ tokens of accumulated notes with duplicate observations, stale context, and outright contradictions.

**How to avoid:**
- Assign every lesson a scope: `repository` (applies to this codebase), `workflow` (applies to this workflow type), `issue-type` (applies to issues with these labels), `global` (applies everywhere). Only inject relevant-scope lessons.
- Implement lesson confidence decay: lessons that contradict newer lessons lose confidence; lessons unseen for 30 days lose confidence. Low-confidence lessons are not injected.
- Hard cap total injected lesson tokens at 500 tokens per run (about 5-8 lessons). Selection: highest-confidence, highest-scope-match, least-recently-validated.
- Never auto-inject all lessons. Use retrieval: given the current issue/workflow, retrieve the top-N most relevant lessons by similarity, not by recency.
- Add a lesson review command: `forgectl outcomes review` that shows the current lesson store and confidence scores, so humans can prune bad lessons.
- Flag contradictory lessons immediately on insertion: if a new lesson contradicts an existing one, mark both as conflicted rather than silently accumulating both.

**Warning signs:**
- Lesson store growing unboundedly with no expiry mechanism
- All lessons injected into every run regardless of scope relevance
- No mechanism to detect or resolve contradictory lessons
- Agent performance degrading over time despite more accumulated lessons
- Lesson prompt section exceeding 1,000 tokens

**Phase to address:** Outcome Learning phase

---

### Pitfall 8: Dead-End Tracking Misfires on Intermittent Failures

**What goes wrong:**
The system records that "approach X failed on issue Y" as a dead end. On future issues similar to Y, it warns the agent away from approach X. But approach X failed because of a transient environment issue (Docker network blip, temp disk full), not because X is a bad approach. The agent is now permanently warned away from a valid approach based on a false signal. Over time, the dead-end store becomes a blacklist of valid approaches that failed for coincidental reasons.

**Why it happens:**
Dead-end tracking needs to distinguish "this approach failed because it's wrong" from "this approach failed because the environment was broken". The failure classifier in `retry.ts` currently only distinguishes `continuation` vs `error`, with no environment/approach distinction.

**How to avoid:**
- Only record a dead end after N (default: 3) failures of the same approach on different issues. Single-occurrence failures are noise.
- Dead ends recorded at the approach level must include the failure reason. If the failure reason was infrastructure (timeout, network error, disk full), do not record a dead end.
- Dead ends have a time-to-live (default: 60 days). Approaches that failed in an older codebase state may be valid in the current state.
- Distinguish dead-end types: `approach-dead-end` (this pattern doesn't work in this codebase) vs `solution-dead-end` (this specific implementation was tried and rejected by validation). Only `approach-dead-end` propagates to future runs.
- Allow agents to explicitly mark a dead end with a reason: `[DEAD END: approach failed because X]` in their output, which is more reliable than inferring from exit codes.

**Warning signs:**
- Dead ends recorded after a single failure
- Infrastructure failures (timeouts, network errors) stored as approach dead ends
- Dead-end count growing rapidly over a short time period (suggests infrastructure instability, not bad approaches)
- No TTL or expiry on dead-end records

**Phase to address:** Outcome Learning phase

---

### Pitfall 9: Breaking the Single-Agent Path by Adding Decomposition Middleware

**What goes wrong:**
Decomposition logic is added to the dispatch path as middleware that always runs. Simple, single-file issues now go through decomposition analysis before execution. The LLM is called to produce a plan, the plan is a single node, the node is dispatched as a "decomposed" task, and it executes through the new worktree path. This adds 10-30 seconds to every issue's dispatch latency, breaks the existing validation retry logic (which doesn't work the same way with worktree sub-tasks), and breaks the existing checkpoint/resume (which targets the single-agent execution model). Users with simple issues experience performance regression.

**Why it happens:**
Decomposition is added as a feature and "wired in" to the dispatch path because it's the exciting new capability. Developers don't think to gate it behind a threshold or keep the old path as the primary path. The existing dispatcher is complex enough that adding middleware is tempting for simplicity.

**How to avoid:**
- Decomposition is opt-in by default: only trigger decomposition when the issue explicitly requests it (label `forge:decompose`) or when a complexity threshold is exceeded (estimated tokens > threshold, issue body > N words, or explicit config flag)
- The single-agent path is the default. Decomposition is a named alternative path, not middleware on the default path.
- All existing tests must pass without modification after decomposition is added. If any single-agent test fails, the integration is broken.
- Add a `FORGECTL_SKIP_DECOMPOSITION=true` environment variable that forces single-agent execution, for debugging and rollback.
- The existing `classifyFailure`, `scheduleRetry`, and checkpoint/resume logic should not be modified for decomposition — decomposed runs should either fully replace the worker execution or wrap it, never partially mutate it.

**Warning signs:**
- Decomposition code in the main `dispatchIssue` function rather than a separate code path
- Existing unit tests in `test/unit/` failing after decomposition is added
- No way to force single-agent execution on an issue that would otherwise be decomposed
- Decomposition analysis running for issues with single-line descriptions

**Phase to address:** Decomposition Engine phase (from the first commit)

---

### Pitfall 10: Worktree Runtime Bypassing Docker Sandbox Security

**What goes wrong:**
The worktree + process runtime is designed for "trusted sub-tasks" but "trusted" is never formally defined. The worktree spawns a Node.js child process with the agent, which runs with full host filesystem access, full network access, and the same user credentials as the daemon. An agent running a malicious or buggy command (e.g., `rm -rf /`, curl to an external service, access to `~/.ssh`) has no sandbox protection. The Docker container runtime exists precisely to prevent this. The new worktree runtime silently removes it.

**Why it happens:**
Worktree runtimes are added for performance (no Docker overhead). "Trusted" is assumed to mean the code is safe without verifying what "trusted" means in practice. The Docker sandbox protections (network isolation, filesystem isolation, no host credentials) are only appreciated after they prevent an incident.

**How to avoid:**
- Define "trusted" formally in WORKFLOW.md as an explicit opt-in: `runtime: worktree` requires `trusted: true` in the workflow config, and `trusted: true` requires a human-reviewed whitelist of allowed operations
- The worktree runtime must run the agent with a reduced-privilege user (not the daemon's user), in a chroot or similar namespace, with network access restricted to specific hosts
- Default runtime is always Docker. Worktree runtime requires explicit configuration and logs a prominent warning on first use.
- The agent's working directory in the worktree runtime must be constrained to the worktree path — the existing `WorkspaceManager` path sanitization (`src/workspace/`) must be applied
- Test the worktree runtime with a "malicious agent" that attempts to read `~/.ssh/config` — verify it cannot

**Warning signs:**
- Worktree runtime spawning the agent with `process.env` (exposes all host environment variables including tokens)
- No chroot, namespace, or equivalent isolation in the worktree runtime
- Worktree runtime enabled by default without explicit configuration
- No test verifying that the worktree agent cannot access host credentials

**Phase to address:** Worktree Runtime phase

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Skip semantic validation of decomposition output | Faster implementation | Bad plans execute and produce incoherent output; harder to debug than single-agent failure | Never in production |
| All decomposed nodes run in parallel by default | Simpler scheduling logic | High merge conflict rate; plan quality degrades silently | Never — sequential dependencies are load-bearing |
| Store all lessons forever with no expiry | Simple implementation | Contradictory lessons degrade agent performance; prompt bloat | Never |
| Rate limit detection via text pattern only | Quick to implement | Misclassifies context errors, disk errors, and infra failures as rate limits | Only as fallback when HTTP status is not available |
| Worktree cleanup as best-effort fire-and-forget | Less error handling code | Orphaned worktrees accumulate; eventual disk fillup and branch name collisions | Never — cleanup must be synchronous and verified |
| Single outcome learning store shared across all workflows | Less infrastructure | Lessons from code workflows contaminate research workflows; low signal-to-noise | Only if all workflows are semantically identical |

---

## Integration Gotchas

Common mistakes when connecting new features to the existing orchestrator.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Decomposition → existing DAG validator | Using `pipeline/dag.ts` validateDAG directly — it rejects unknown node references valid in sub-issue context | The decomposition DAG is a different type from the pipeline DAG; use a separate validator or extend DAG types |
| Decomposition → existing dispatcher | Calling `dispatchIssue` for each decomposed node — it adds the issue to the orchestrator state as if it's a real issue | Decomposed nodes need their own dispatch mechanism that doesn't pollute `state.running` with fake issue IDs |
| Worktree runtime → existing workspace manager | Bypassing WorkspaceManager for worktree paths — path sanitization and containment checks are in WorkspaceManager | All worktree paths must go through WorkspaceManager even if Docker is not involved |
| Rate limit retry → existing retry scheduler | Adding a new timer for rate limit delays alongside `state.retryTimers` — two timer systems for the same issue | Extend `scheduleRetry` with a `reason` field rather than creating a parallel mechanism |
| Outcome learning → flight recorder | Writing lessons to the flight recorder event log — events are audit trail, not retrieval source | Lessons need their own `lessons` table in SQLite with retrieval-optimized schema (scope, confidence, issue_type) |
| Decomposition → GitHub sub-issue DAG | Conflating LLM-generated decomposition DAG with GitHub sub-issue hierarchy DAG — they have different IDs, lifetimes, and semantics | Keep them separate: sub-issue DAG uses GitHub issue numbers; decomposition DAG uses ephemeral node IDs scoped to the run |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Calling LLM for decomposition on every issue regardless of complexity | Dispatch latency increases by 10-30 seconds for all issues | Gate decomposition behind complexity threshold or explicit label | Immediately, even at low volume |
| Injecting all lessons into every run | Token costs increase linearly with lesson count; context window pressure | Cap injection at 500 tokens; use retrieval not broadcast | When lesson count exceeds ~10 entries |
| Creating a worktree per decomposed node without cleanup on failure | Disk fills, branch names collide, `git worktree list` grows unbounded | Mandatory cleanup in try/finally; startup prune; SQLite tracking | After the first set of failures |
| Loading full lesson history for retrieval on every dispatch | SQLite query time grows with table size; dispatch latency increases | Index on (scope, workflow, confidence); limit to top-20 rows in query | >1,000 lessons (~6 months of heavy use) |
| Parallel merge strategy that loads all node branches simultaneously | Memory spike during merge of large codebases | Merge branches sequentially, one at a time, with conflict detection after each | Codebases >500MB or >5 parallel nodes |
| Recording a lesson for every single failed validation step | Lessons overwhelmed with micro-failures; retrieval signal collapses | Only record lessons at run completion level, not at individual step level | After the first week of heavy use |

---

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Worktree agent inheriting daemon's environment variables | Agent reads `ANTHROPIC_API_KEY`, GitHub tokens, or other secrets from env | Spawn worktree agent with stripped env; pass only required variables explicitly |
| Lesson store containing sensitive data from prior runs | Future agents read file contents, API responses, or credentials from lesson records | Scrub PII and secrets from lesson content before storage; lessons should describe patterns, not replay raw content |
| Decomposition prompt leaking full issue body to a different LLM | If decomposition uses a separate model, the issue body (potentially containing repo context) goes to that model | Use the same LLM provider for decomposition as for execution; no cross-provider context sharing |
| Decomposed node branches lingering after run completes | Old branches in the repo expose partial implementation details or credentials in committed files | Auto-delete node branches after successful merge; never push node branches to origin |
| Rate limit scheduler revealing internal retry state via GitHub comments | Comments saying "retrying in 300 seconds due to rate limit" expose orchestrator internals | Use vague user-facing messages; log detailed retry state internally only |

---

## UX Pitfalls

Common user experience mistakes when adding these features.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Showing decomposition plan as a wall of JSON in GitHub comment | User cannot understand what will be executed | Render the plan as a markdown checklist with node descriptions; use code block only for the raw JSON in a collapsed `<details>` section |
| Posting a comment for every decomposed node start/complete | 5 nodes = 10 comments; user gets spammed | Roll up all node progress into a single comment that updates in place (existing rollup pattern from v3.0) |
| Rate limit retry with no user-visible indication | User thinks the run is stalled/hung | Post a comment: "Rate limited by Claude API — retrying in 5 minutes. Workspace preserved." |
| Outcome learning silently changing agent behavior | User cannot understand why the agent is now avoiding certain approaches | Expose active lessons in the progress comment: "Based on 3 prior runs, skipping X approach" |
| Fallback to single-agent presented as a failure | User thinks decomposition failed when it gracefully fell back | Message: "Issue is simple enough to handle directly — using single-agent mode" not "Decomposition failed, falling back" |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Decomposition engine:** Often missing semantic validation — verify that overlapping file scope and test-without-implementation-dependency are detected
- [ ] **Decomposition engine:** Often missing the fallback-to-single-agent path — verify that a bad plan score triggers clean fallback with no orphaned state
- [ ] **Worktree runtime:** Often missing cleanup on bootstrap failure — verify that a failure between `git worktree add` and agent spawn leaves no orphaned directory
- [ ] **Worktree runtime:** Often missing startup prune — verify `git worktree prune` runs on daemon startup
- [ ] **Parallel merge:** Often missing conflict detection — verify that a merge conflict triggers re-plan, not silent overwrite
- [ ] **Rate limit detection:** Often missing test against real CLI error strings — verify classifier against actual Claude Code and Codex error output, not synthetic strings
- [ ] **Rate limit retry:** Often missing the committed checkpoint before suspension — verify a git commit is created in the worktree before the workspace is preserved
- [ ] **Outcome learning:** Often missing contradiction detection — verify that a new lesson contradicting an existing one is flagged, not silently appended
- [ ] **Outcome learning:** Often missing lesson scoping — verify that code-workflow lessons are not injected into research-workflow runs
- [ ] **Outcome learning:** Often missing token cap enforcement — verify that the injected lesson context never exceeds 500 tokens regardless of lesson count
- [ ] **Backward compatibility:** Often missing after integration — verify existing `forgectl run` and `forgectl pipeline` commands complete without regression using existing tests

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Bad decomposition plan executed, repo in incoherent state | HIGH | Identify all node branches; delete them; re-run as single-agent; add semantic validation retroactively |
| Orphaned worktrees filling disk | LOW | Run `git worktree prune`; manually delete orphaned directories; add startup prune to daemon |
| Merge conflict from parallel nodes on shared file | MEDIUM | Delete the conflicting branches; re-run the decomposition with explicit file-ownership constraints in the prompt |
| Rate limit misclassification in retry loop | LOW | Kill the stuck retry timer; add the error pattern to the misclassification blocklist; re-dispatch the issue |
| Polluted lesson store degrading agent quality | MEDIUM | Run `forgectl outcomes review`; purge low-confidence and contradictory lessons; add automatic confidence decay retroactively |
| Worktree agent accessed host credentials | HIGH | Rotate all exposed secrets immediately; add env stripping to worktree spawn; audit all runs that used the worktree runtime |
| Single-agent path broken by decomposition middleware | MEDIUM | Revert decomposition middleware; restore original dispatch path; re-add decomposition as separate gated code path |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Decomposition produces valid but bad plan | Decomposition Engine | Semantic validation test suite with overlapping nodes, orphaned tests, single-node plans |
| Bad plan worse than no plan | Decomposition Engine + Parallel Execution | Integration test: partial failure triggers fallback; no orphaned state after fallback |
| Orphaned worktrees on bootstrap failure | Worktree Runtime | Fault injection test: kill process between `worktree add` and agent spawn; verify cleanup |
| Parallel nodes touching shared files | Parallel Execution / Merge | Integration test: two nodes modifying same file; verify conflict detection, not silent overwrite |
| Rate limit misclassification | Rate Limit Retry | Classifier unit test with corpus of real Claude Code and Codex error strings |
| Workspace preservation preserving incoherent state | Rate Limit Retry | Integration test: rate limit mid-agent; verify git commit exists before workspace suspension |
| Outcome learning noise > signal | Outcome Learning | Load test: 100 lessons inserted; verify contradiction detection, token cap, scope filtering |
| Dead-end tracking misfires on infra failures | Outcome Learning | Test: infrastructure failure recorded as dead end; verify it is not propagated to future runs |
| Breaking single-agent path | Decomposition Engine (first phase) | All existing unit tests pass unchanged after decomposition integration |
| Worktree runtime security bypass | Worktree Runtime | Security test: worktree agent attempts to read host credentials; verify failure |

---

## Sources

- [OpenCode worktree bootstrap failure issue](https://github.com/anomalyco/opencode/issues/14648) — real-world orphaned worktree disk fillup case (HIGH confidence — direct issue report)
- [OpenCode worktree cleanup fix PR](https://github.com/anomalyco/opencode/pull/14649) — the cleanupFailedWorktree pattern (HIGH confidence — merged production fix)
- [OpenAI Codex worktree orphaned processes issue](https://github.com/openai/codex/issues/11090) — PPID=1 orphaned processes, multi-instance execution (HIGH confidence — direct issue report)
- [Clash: detect git worktree conflicts before parallel agent edits](https://github.com/clash-sh/clash) — file-level conflict pre-detection for parallel agents (HIGH confidence — active tool)
- [Git worktrees for parallel AI coding agents - Upsun](https://devcenter.upsun.com/posts/git-worktrees-for-parallel-ai-coding-agents/) — parallel execution pitfalls, cleanup best practices (MEDIUM confidence)
- [Why your multi-agent system is failing - Towards Data Science](https://towardsdatascience.com/why-your-multi-agent-system-is-failing-escaping-the-17x-error-trap-of-the-bag-of-agents/) — error compounding in multi-agent systems (MEDIUM confidence)
- [MAST: Multi-Agent System Failure Taxonomy](https://arxiv.org/pdf/2503.13657) — decomposition failure modes, coordination failures (HIGH confidence — peer-reviewed)
- [Why AI agents need a database for memory, not just a flat file](https://glenrhodes.com/why-ai-agents-need-a-database-for-memory-not-just-a-flat-file-like-skill-md/) — memory contamination, lesson pollution (MEDIUM confidence)
- [No More Stale Feedback: Co-Evolving Critics for Agent Learning](https://arxiv.org/abs/2601.06794) — stale lesson problem in agent feedback loops (HIGH confidence — peer-reviewed)
- [AI Agents Need Memory Control Over More Context](https://arxiv.org/html/2601.11653) — transcript replay amplifies noise, retrieval selection error (HIGH confidence — peer-reviewed)
- [Agentic AI systems don't fail suddenly — they drift over time](https://www.cio.com/article/4134051/agentic-ai-systems-dont-fail-suddenly-they-drift-over-time.html) — behavioral drift from accumulated lessons (MEDIUM confidence)
- [OpenAI rate limit handling cookbook](https://cookbook.openai.com/examples/how_to_handle_rate_limits) — retry patterns, thundering herd, failed requests count against limits (HIGH confidence — official)
- [How to leverage git trees for parallel agent workflows](https://elchemista.com/en/post/how-to-leverage-git-trees-for-parallel-agent-workflows) — worktree patterns, disk multiplier problem (MEDIUM confidence)
- [Engineer agent reliability — not just prompt it](https://www.aiyan.io/blog/engineer-agent-reliability/) — structured output validation over text parsing (MEDIUM confidence)
- Existing forgectl codebase: `src/pipeline/dag.ts`, `src/orchestrator/dispatcher.ts`, `src/orchestrator/retry.ts` — integration points for new features (HIGH confidence — direct inspection)

---
*Pitfalls research for: forgectl v5.0 Intelligent Decomposition*
*Researched: 2026-03-14*
