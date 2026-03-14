# Phase 26: Skill / Config Bind-Mounting - Context

**Gathered:** 2026-03-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Agents inside containers discover and use personal skills, project skills, and CLAUDE.md files without credential exposure. This phase adds selective bind-mounting of `~/.claude/skills/` and `~/.claude/agents/` into containers, a `skills:` workflow config section, `--add-dir` flag generation for Claude Code, and credential file exclusion validation. Does NOT include skill marketplace, dynamic skill generation, or skill creation from inside containers.

</domain>

<decisions>
## Implementation Decisions

### Mount Scope & Filtering
- Mount individual subdirectories (`~/.claude/skills/<name>`, `~/.claude/agents/<name>`) as separate read-only bind mounts — never mount the full `~/.claude/` tree for skills
- Refactor `prepareClaudeMounts()` for OAuth sessions: replace the blanket `~/.claude` mount with targeted mounts for only the specific auth files Claude Code needs (session tokens, etc.). Skills mounter handles skill dirs separately
- All skill/config mounts are `:ro` — agents write to workspace only, never back to host skill directories
- If `~/.claude/skills/` or `~/.claude/agents/` doesn't exist on host, log at debug level and skip silently
- Add `--no-skills` CLI flag to disable all skill/config mounting for a run (useful for testing vanilla agent behavior)

### Skill Selection in Workflows
- Explicit list syntax in WORKFLOW.md front matter: `skills: ["code-review", "testing", "gsd"]`
- Only listed skill directories get mounted — no globs, no wildcards
- If no `skills:` section is present, mount nothing (opt-in model, not opt-out)
- Fixed container mount paths — skills always mount at a consistent location (e.g., `/home/node/.claude/skills/<name>`)
- Extend Zod config schema with `skills` array in WorkflowSchema (SKILL-05)

### Container Discovery
- Generate `--add-dir /home/node/.claude/skills/<name>` flag for each mounted skill directory
- Auto-generate `--add-dir` flags and merge into existing `agent.flags` array — `buildShellCommand()` already iterates flags, no adapter changes needed
- `agents/` directories treated identically to `skills/` for mounting and `--add-dir` discovery

### Credential Boundary
- Auth mounts and skill mounts are separate concerns — auth system continues mounting whatever Claude Code needs for OAuth/API keys (existing `prepareClaudeMounts()`/`prepareCodexMounts()`)
- Skill mounts must never include credential files (`.credentials.json`, token files, `statsig/`, etc.)
- Post-mount validation: after setting up all binds, scan the bind list for known credential patterns and fail the run if any skill mount accidentally includes credentials (defense in depth)

### Claude's Discretion
- Credential deny-list approach (hardcoded vs pattern-based) — pick based on security tradeoffs
- Whether `.claude.json` is included in skill mounts or handled only by auth system
- How `CLAUDE.md` discovery works inside the container (mount at equivalent path vs prompt injection)
- Missing skill handling (warn + continue vs fail) when workflow lists a skill that doesn't exist on host
- Whether project-level `.claude/` directories (in workspace repo) also get skill-mounted or just rely on workspace bind-mount

</decisions>

<specifics>
## Specific Ideas

- OAuth mount refactoring is the critical change — current code mounts all of `~/.claude` which exposes credentials. The new approach separates auth (targeted file mounts) from skills (directory mounts)
- `--no-skills` flag enables clean testing: run the same workflow with and without skills to verify agent behavior
- The existing `agent.flags` array in RunPlan is the natural integration point — skill mounting generates flags, no new adapter interface needed

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `prepareClaudeMounts()` at `src/auth/mount.ts:14`: Current auth mount logic — needs refactoring to be more targeted for OAuth sessions
- `ContainerMounts` interface at `src/auth/mount.ts:8`: `{ binds, env, cleanup }` — same shape works for skill mounts
- `claudeCodeAdapter.buildShellCommand()` at `src/agent/claude-code.ts:6`: Already iterates `options.flags` — just push `--add-dir` flags into the array
- `WorkflowSchema` at `src/config/schema.ts:41`: Zod schema to extend with `skills` array
- `WorkflowFileConfig` at `src/workflow/types.ts:9`: TypeScript interface to extend with `skills` field

### Established Patterns
- Bind mounts assembled as string arrays (`binds: string[]`) throughout `src/orchestration/single.ts`
- Auth mounts produce `ContainerMounts` with cleanup callbacks — skill mounts should follow the same pattern
- Config schema uses Zod with `.default([])` for optional arrays — skills follows this pattern
- 4-layer merge: defaults → forgectl.yaml → WORKFLOW.md → CLI flags — skills config participates in this merge

### Integration Points
- `prepareExecution()` at `src/orchestration/single.ts:60`: Assembles all binds before `createContainer()` — skill binds added here
- `createContainer()` at `src/container/runner.ts:16`: Receives `binds` array — no changes needed, just pass more binds
- `agentOptions.flags` built in `prepareExecution()` at line 163 — `--add-dir` flags merged here
- `WorkflowFileConfig` in `src/workflow/types.ts` and `mapFrontMatter()` in `src/workflow/map-front-matter.ts` — skill config parsing

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 26-skill-config-bind-mounting*
*Context gathered: 2026-03-13*
