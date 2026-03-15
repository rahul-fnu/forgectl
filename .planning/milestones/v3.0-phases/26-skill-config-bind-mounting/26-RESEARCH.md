# Phase 26: Skill / Config Bind-Mounting - Research

**Researched:** 2026-03-13
**Domain:** Docker bind-mount management, Claude Code skill discovery, Zod schema extension
**Confidence:** HIGH

## Summary

Phase 26 adds selective bind-mounting of host skill/config directories into containers so Claude Code agents can discover and use personal and project skills without exposing credentials. The work is purely additive to the existing mount, schema, and orchestration patterns — no new external dependencies, no architectural changes.

The critical security concern is the current `prepareClaudeMounts()` OAuth path, which mounts the entire `~/.claude/` tree into `/home/node/.claude`. This must be refactored to only mount specific auth files, and a separate skill mounter must handle skill/agent directories with a credential-file deny-list validation pass.

The integration surface is narrow and well-understood: (1) a new `src/skills/mount.ts` module, (2) Zod schema extension in `WorkflowFrontMatterSchema` and `WorkflowFileConfig`, (3) `--add-dir` flag injection in `prepareExecution()`, and (4) a `--no-skills` CLI flag. All mount assembly already flows through `binds: string[]` in `prepareExecution()` before `createContainer()` — skills binds follow the exact same pattern.

**Primary recommendation:** Build a `prepareSkillMounts()` function that mirrors `prepareClaudeMounts()`'s `ContainerMounts` return shape, validate the bind list for credential patterns before returning, and inject the resulting binds and `--add-dir` flags at the single assembly point in `prepareExecution()`.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Mount Scope & Filtering**
- Mount individual subdirectories (`~/.claude/skills/<name>`, `~/.claude/agents/<name>`) as separate read-only bind mounts — never mount the full `~/.claude/` tree for skills
- Refactor `prepareClaudeMounts()` for OAuth sessions: replace the blanket `~/.claude` mount with targeted mounts for only the specific auth files Claude Code needs (session tokens, etc.). Skills mounter handles skill dirs separately
- All skill/config mounts are `:ro` — agents write to workspace only, never back to host skill directories
- If `~/.claude/skills/` or `~/.claude/agents/` doesn't exist on host, log at debug level and skip silently
- Add `--no-skills` CLI flag to disable all skill/config mounting for a run (useful for testing vanilla agent behavior)

**Skill Selection in Workflows**
- Explicit list syntax in WORKFLOW.md front matter: `skills: ["code-review", "testing", "gsd"]`
- Only listed skill directories get mounted — no globs, no wildcards
- If no `skills:` section is present, mount nothing (opt-in model, not opt-out)
- Fixed container mount paths — skills always mount at a consistent location (e.g., `/home/node/.claude/skills/<name>`)
- Extend Zod config schema with `skills` array in WorkflowSchema (SKILL-05)

**Container Discovery**
- Generate `--add-dir /home/node/.claude/skills/<name>` flag for each mounted skill directory
- Auto-generate `--add-dir` flags and merge into existing `agent.flags` array — `buildShellCommand()` already iterates flags, no adapter changes needed
- `agents/` directories treated identically to `skills/` for mounting and `--add-dir` discovery

**Credential Boundary**
- Auth mounts and skill mounts are separate concerns — auth system continues mounting whatever Claude Code needs for OAuth/API keys (existing `prepareClaudeMounts()`/`prepareCodexMounts()`)
- Skill mounts must never include credential files (`.credentials.json`, token files, `statsig/`, etc.)
- Post-mount validation: after setting up all binds, scan the bind list for known credential patterns and fail the run if any skill mount accidentally includes credentials (defense in depth)

### Claude's Discretion
- Credential deny-list approach (hardcoded vs pattern-based) — pick based on security tradeoffs
- Whether `.claude.json` is included in skill mounts or handled only by auth system
- How `CLAUDE.md` discovery works inside the container (mount at equivalent path vs prompt injection)
- Missing skill handling (warn + continue vs fail) when workflow lists a skill that doesn't exist on host
- Whether project-level `.claude/` directories (in workspace repo) also get skill-mounted or just rely on workspace bind-mount

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SKILL-01 | Mount CLAUDE.md, skills/, and agents/ directories into containers with read-only bind mounts | `prepareSkillMounts()` assembles `:ro` bind strings; `existsSync()` guards missing dirs; `ContainerMounts` shape reused |
| SKILL-02 | Exclude credential files (`.credentials.json`, token files, `statsig/`) from all mounts | Post-mount credential deny-list validation in `prepareSkillMounts()`; OAuth refactor removes blanket `~/.claude` mount |
| SKILL-03 | Pass `--add-dir` flag to Claude Code so agents discover mounted skill directories | `--add-dir` flags pushed into `agentOptions.flags` in `prepareExecution()`; `buildShellCommand()` already iterates `options.flags` |
| SKILL-04 | Support workflow-specific skill selection via `skills:` section in WORKFLOW.md | `WorkflowFrontMatterSchema` extended with `skills` field; `WorkflowFileConfig` interface extended |
| SKILL-05 | Extend config schema (Zod) with `skills` section for per-workflow skill configuration | `WorkflowSchema` in `src/config/schema.ts` extended with `skills: z.array(z.string()).default([])` |
</phase_requirements>

---

## Standard Stack

### Core (all existing — zero new dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:fs` | built-in | `existsSync()`, `readdirSync()` for host-side skill discovery | Already used throughout `src/auth/mount.ts` |
| `node:path` | built-in | `join()`, `homedir()` for composing bind strings | Project convention — never string concatenation |
| `node:os` | built-in | `homedir()` to resolve `~/.claude/` on host | Used by existing auth code |
| `zod` | existing | Schema extension for `skills` field | Already the schema validation library |
| `dockerode` | existing | No changes needed — just passes more bind strings | `createContainer()` accepts `binds` array as-is |

**Installation:** No new packages needed.

---

## Architecture Patterns

### Recommended New File Structure
```
src/
├── auth/
│   └── mount.ts          # MODIFY: refactor OAuth path, add prepareSkillMounts()
├── config/
│   └── schema.ts         # MODIFY: add skills to WorkflowSchema
├── workflow/
│   ├── types.ts          # MODIFY: add skills to WorkflowFileConfig
│   └── workflow-file.ts  # MODIFY: add skills to WorkflowFrontMatterSchema
├── orchestration/
│   └── single.ts         # MODIFY: call prepareSkillMounts(), inject --add-dir flags
└── index.ts              # MODIFY: add --no-skills flag to run command
```

### Pattern 1: ContainerMounts Shape (existing, reuse verbatim)
**What:** `prepareSkillMounts()` returns the same `{ binds, env, cleanup }` shape as `prepareClaudeMounts()`.
**When to use:** Whenever assembling container bind mounts — lets `prepareExecution()` spread binds from multiple sources without structural differences.

```typescript
// Source: src/auth/mount.ts (existing interface)
export interface ContainerMounts {
  binds: string[];                   // Docker bind mount strings: "host:container:ro"
  env: Record<string, string>;       // empty for skill mounts
  cleanup: () => void;               // no-op for skill mounts (no temp files to clean)
}
```

### Pattern 2: Bind String Format (existing, verified)
**What:** Docker bind strings are assembled as `"${hostAbsPath}:${containerAbsPath}:ro"`.
**When to use:** Every bind mount in this codebase.

```typescript
// Source: src/orchestration/single.ts lines 77, 82-83
binds.push(`${workspaceDir}:${plan.input.mountPath}`);
binds.push(`${inputDir}:${plan.input.mountPath}:ro`);
// Skill pattern follows the same shape:
binds.push(`${hostSkillDir}:/home/node/.claude/skills/${name}:ro`);
```

### Pattern 3: Optional Array in Zod Schema (existing pattern)
**What:** `z.array(z.string()).default([])` for optional arrays with empty default.
**When to use:** Any optional list field in `WorkflowSchema` or `ConfigSchema`.

```typescript
// Source: src/config/schema.ts (tools field, line 56)
tools: z.array(z.string()).default([]),
// Skills follows the same:
skills: z.array(z.string()).default([]),
```

### Pattern 4: WorkflowFrontMatterSchema Extension (existing strict schema)
**What:** `WorkflowFrontMatterSchema` uses `.strict()` — every new WORKFLOW.md key MUST be explicitly added or it will throw `ZodError` on unknown keys.
**When to use:** Adding any new WORKFLOW.md front matter field.

```typescript
// Source: src/workflow/workflow-file.ts line 35-98
export const WorkflowFrontMatterSchema = z.object({
  // ... existing fields ...
  skills: z.array(z.string()).optional(),  // ADD: opt-in, absent = no skills mounted
}).strict();
```

Also update `WorkflowFileConfig` interface in `src/workflow/types.ts`:
```typescript
export interface WorkflowFileConfig {
  // ... existing fields ...
  skills?: string[];
}
```

### Pattern 5: CLI Flag Registration (commander, existing pattern)
**What:** Boolean flags are registered with `.option()` on the `run` command in `src/index.ts`, then carried through `CLIOptions` and `resolveRunPlan()`.
**When to use:** Adding any new CLI flag that affects run behavior.

```typescript
// Source: src/index.ts lines 44-52 (existing run command options)
.option("--no-skills", "Disable skill/config bind-mounting for this run")
// CLIOptions in src/workflow/resolver.ts needs: noSkills?: boolean
```

### Pattern 6: OAuth Refactor — Targeted File Mounts
**What:** Current `prepareClaudeMounts()` OAuth branch mounts `${auth.sessionDir}:/home/node/.claude:ro` (entire directory). This must become targeted individual file mounts.
**When to use:** This is the critical security fix in SKILL-02.

The OAuth session directory (`~/.claude/`) contains:
- `claude_desktop_config.json` or session token files — needed
- `statsig/` directory — NOT needed, potentially sensitive
- `.credentials.json` — NOT needed inside container

Refactored approach: copy only the session token file(s) to `secretsDir` (same temp dir pattern used for API key) and mount that instead:

```typescript
// Refactored src/auth/mount.ts OAuth path
} else if (auth.type === "oauth_session" && auth.sessionDir) {
  // Copy only auth tokens — never mount the full session dir
  const tokenFiles = ["credentials", "session.json"]; // names to check
  for (const name of tokenFiles) {
    const src = join(auth.sessionDir, name);
    if (existsSync(src)) {
      const dst = join(secretsDir, name);
      writeFileSync(dst, readFileSync(src), { mode: 0o400 });
    }
  }
  binds.push(`${secretsDir}:/run/claude-auth:ro`);
  env.HOME = "/home/node";
}
```

Note: The exact files Claude Code OAuth needs inside the container must be verified during implementation — the session dir structure is Claude Code implementation detail. The pattern (copy specific files, not the whole dir) is the locked decision.

### Pattern 7: prepareSkillMounts() Function
**What:** New function in `src/auth/mount.ts` (or a new `src/skills/mount.ts`) that takes `skills: string[]` (from workflow config) and `noSkills: boolean` (CLI flag) and returns `ContainerMounts`.

```typescript
// New function — can live alongside existing mounts in src/auth/mount.ts
export function prepareSkillMounts(
  skills: string[],
  noSkills: boolean,
): { mounts: ContainerMounts; addDirFlags: string[] } {
  if (noSkills || skills.length === 0) {
    return { mounts: { binds: [], env: {}, cleanup: () => {} }, addDirFlags: [] };
  }

  const skillsBase = join(homedir(), ".claude", "skills");
  const agentsBase = join(homedir(), ".claude", "agents");
  const binds: string[] = [];
  const addDirFlags: string[] = [];

  for (const name of skills) {
    // Check ~/.claude/skills/<name> first
    const skillHostPath = join(skillsBase, name);
    const containerSkillPath = `/home/node/.claude/skills/${name}`;
    if (existsSync(skillHostPath)) {
      validateNoCredentials(skillHostPath);   // throws if credentials found
      binds.push(`${skillHostPath}:${containerSkillPath}:ro`);
      addDirFlags.push(`--add-dir`, containerSkillPath);
    }

    // Then check ~/.claude/agents/<name>
    const agentHostPath = join(agentsBase, name);
    const containerAgentPath = `/home/node/.claude/agents/${name}`;
    if (existsSync(agentHostPath)) {
      validateNoCredentials(agentHostPath);
      binds.push(`${agentHostPath}:${containerAgentPath}:ro`);
      addDirFlags.push(`--add-dir`, containerAgentPath);
    }
  }

  return {
    mounts: { binds, env: {}, cleanup: () => {} },
    addDirFlags,
  };
}
```

### Anti-Patterns to Avoid
- **Mounting `~/.claude` in full for OAuth:** Exposes `statsig/`, `.credentials.json`, usage telemetry. Locked decision says targeted mounts only.
- **Using globs or wildcards for skill selection:** Locked decision: explicit list only in `skills:` array. Prevents accidental mounting of unexpected dirs.
- **Adding `--add-dir` flags with single combined string:** `buildShellCommand()` calls `shellEscape()` on each element — flags and their values must be separate array entries (`"--add-dir"`, `"/path/..."`) so each gets independently escaped.
- **Mounting project-level `.claude/` separately:** Project `.claude/` directories inside the workspace repo are already bind-mounted via workspace bind — no additional handling needed.
- **Credential deny-list as runtime discovery:** The deny-list should be a hardcoded set of known dangerous filenames (`CREDENTIAL_DENY_LIST`) not a pattern-based scan — simpler, predictable, easier to audit.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Bind string format | Custom mount DSL | `string[]` of `"host:container:ro"` | Already the project standard; `createContainer()` accepts it directly |
| Temp dir for auth file copies | Custom temp management | `join(tmpdir(), ...)` + `cleanup()` callback | Exact same pattern as existing `prepareClaudeMounts()` secretsDir |
| Flag iteration in agent command | New adapter interface | Push to `agentOptions.flags` | `buildShellCommand()` already calls `shellEscape()` on each flag |
| Zod schema validation | Custom YAML validator | `z.array(z.string()).optional()` | Exact same pattern as `tools` field |

---

## Common Pitfalls

### Pitfall 1: WorkflowFrontMatterSchema is `.strict()`
**What goes wrong:** Adding `skills` to `WorkflowFileConfig` TypeScript interface but forgetting to add it to `WorkflowFrontMatterSchema` causes `ZodError` on any WORKFLOW.md that uses `skills:`. The schema uses `.strict()` which rejects unknown keys.
**Why it happens:** Two representations of the same shape — the Zod schema and the TypeScript interface. Both must be updated in sync.
**How to avoid:** Update `WorkflowFrontMatterSchema` in `workflow-file.ts`, `WorkflowFileConfig` in `types.ts`, and add a test case to `workflow-file.test.ts`.
**Warning signs:** `ZodError: Unrecognized key(s) in object: 'skills'` at runtime.

### Pitfall 2: `--add-dir` Flag Shell Escaping
**What goes wrong:** Passing `"--add-dir /path/to/skill"` as a single string entry in `options.flags` results in Claude Code receiving the whole string as one argument instead of two. `shellEscape()` wraps it in single quotes.
**Why it happens:** `buildShellCommand()` calls `shellEscape()` on each `flag` element individually and appends with a space. Paths with spaces in skill names would also break.
**How to avoid:** Push flag name and value as separate array entries: `flags.push("--add-dir", containerPath)`. The space between them comes from `buildShellCommand()`'s ` ${shellEscape(flag)}` loop.

### Pitfall 3: OAuth Session Dir Content Assumptions
**What goes wrong:** Assuming specific file names inside `~/.claude/` (e.g., `credentials`, `session.json`) without verifying Claude Code's actual session dir layout. Wrong filenames = agent fails to authenticate.
**Why it happens:** Claude Code's session file naming is internal implementation detail that may vary by installation method (Claude.app vs npm).
**How to avoid:** Check what files Claude Code actually writes to `~/.claude/` on this host before hardcoding the copy list. The existing code reads `auth.sessionDir` which points to the actual dir — inspect it during implementation.

### Pitfall 4: `noUnusedLocals: true` Catches Unused Imports
**What goes wrong:** Importing `homedir` from `node:os` in a new file but only using it inside a conditional branch that's not always reached triggers a false positive — actually TypeScript's `noUnusedLocals` is about declarations not being referenced at all, but careless imports can creep in.
**Why it happens:** `tsconfig.json` has `noUnusedLocals: true` and `noUnusedParameters: true`. Build will fail.
**How to avoid:** Only import what you use. No unused function parameters.

### Pitfall 5: Missing skill is silent by default
**What goes wrong:** A workflow lists `skills: ["gsd"]` but `~/.claude/skills/gsd` doesn't exist. If the code throws or errors, the run fails for a trivial reason.
**How to avoid:** Behavior is discretionary — recommend warn-and-continue (log at `debug` level as CONTEXT.md specifies for missing base dirs). Do NOT fail the run for missing individual skills unless the implementation decision is to do so (document the choice).

### Pitfall 6: Credential deny-list scope
**What goes wrong:** Deny-list only checks top-level file names but credential files may be nested (e.g., `~/.claude/skills/my-skill/.credentials.json`).
**How to avoid:** The deny-list validation in `validateNoCredentials()` should recursively scan for deny-listed filenames, not just check if the directory path itself is a credential file. Use `readdirSync()` with `{ recursive: true }` (Node 20+) or a simple recursive helper.

---

## Code Examples

### Credential Deny-List Validation

```typescript
// Source: derived from project security patterns (no external source)
const CREDENTIAL_DENY_LIST = new Set([
  ".credentials.json",
  "credentials.json",
  "auth.json",          // Codex
  "statsig",            // Claude Code telemetry dir
  ".env",
  "token",
  "api_key",
]);

function validateNoCredentials(hostPath: string): void {
  // Node 20+: readdirSync with recursive option
  const entries = readdirSync(hostPath, { recursive: true }) as string[];
  for (const entry of entries) {
    const basename = entry.split("/").at(-1) ?? entry;
    if (CREDENTIAL_DENY_LIST.has(basename)) {
      throw new Error(
        `Skill mount security violation: credential file "${entry}" found in ${hostPath}. ` +
        `Remove it or use --no-skills to disable skill mounting.`
      );
    }
  }
}
```

### Injecting Skills into prepareExecution()

```typescript
// Source: derived from src/orchestration/single.ts pattern (lines 87-137)
// After credential mounts, before createContainer():
if (plan.agent.type === "claude-code" && !plan.noSkills) {
  const { mounts: skillMounts, addDirFlags } = prepareSkillMounts(
    plan.workflow.skills ?? [],
    false,
  );
  binds.push(...skillMounts.binds);
  // Merge --add-dir flags into agentOptions.flags
  agentOptions.flags = [...agentOptions.flags, ...addDirFlags];
}
```

### Workflow Front Matter Example

```yaml
---
extends: code
skills:
  - code-review
  - testing
  - gsd
---
Your prompt here.
```

### WorkflowSchema Extension

```typescript
// Source: src/config/schema.ts (extend WorkflowSchema)
export const WorkflowSchema = z.object({
  // ... existing fields ...
  skills: z.array(z.string()).default([]),  // ADD: skill names to mount
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Mount `~/.claude` wholesale for OAuth | Mount only specific auth token files | Phase 26 (this phase) | Eliminates credential exposure risk |
| No skill awareness in containers | `--add-dir` flags point Claude Code at mounted skill dirs | Phase 26 (this phase) | Agent can discover and apply skills |
| No `skills:` in WORKFLOW.md | Explicit skill list in front matter | Phase 26 (this phase) | Per-workflow skill customization |

**Deprecated/outdated after this phase:**
- `binds.push(\`${auth.sessionDir}:/home/node/.claude:ro\`)` in `prepareClaudeMounts()` OAuth path — replaced by targeted file copies.

---

## Open Questions

1. **Exact Claude Code OAuth session file names**
   - What we know: `auth.sessionDir` points to `~/.claude/` on the host; existing code binds the whole dir
   - What's unclear: Which specific filenames inside `~/.claude/` Claude Code needs for OAuth inside the container (session token, credentials store, etc.)
   - Recommendation: During Wave 0, inspect `~/.claude/` contents on the dev host to enumerate actual files. Copy only the non-sensitive auth token files. If uncertain, keep existing behavior but layer the skill mounter on top without touching the OAuth path (deferring the OAuth refactor to a follow-up), since SKILL-02 primarily prohibits skill mounts from including credentials, not necessarily requires the OAuth refactor in this phase.

2. **CLAUDE.md discovery inside container**
   - What we know: SKILL-01 mentions "Mount CLAUDE.md" — the host has `~/CLAUDE.md` or project-level CLAUDE.md; the CONTEXT.md marks this as Claude's discretion
   - What's unclear: Whether this means host `~/CLAUDE.md` gets bind-mounted, or only project CLAUDE.md (already in workspace bind-mount)
   - Recommendation: Project CLAUDE.md is already available via workspace bind-mount. Host-level `~/CLAUDE.md` if it exists could be mounted at `/home/node/CLAUDE.md:ro`. Keep it simple — one optional mount, no injection into prompt.

3. **`--add-dir` flag behavior in Claude Code**
   - What we know: CONTEXT.md states `--add-dir` is the correct flag for Claude Code to discover skill directories
   - What's unclear: Exact semantics — does it add to file search path, or does Claude Code treat SKILL.md in the dir as auto-loaded context?
   - Recommendation: Use as specified in CONTEXT.md. Validate in tests by checking the generated shell command string contains expected `--add-dir` flags.

---

## Validation Architecture

Nyquist validation is enabled (`.planning/config.json: nyquist_validation: true`).

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest (existing) |
| Config file | `vitest.config.ts` (existing) |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npm test -- --reporter=verbose test/unit/skill-mount.test.ts` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SKILL-01 | `prepareSkillMounts()` returns binds for listed dirs that exist | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/skill-mount.test.ts` | Wave 0 |
| SKILL-01 | Missing skill dirs are skipped silently (no throw) | unit | same | Wave 0 |
| SKILL-01 | CLAUDE.md mounted when present | unit | same | Wave 0 |
| SKILL-02 | Credential file in skill dir causes throw | unit | same | Wave 0 |
| SKILL-02 | OAuth refactor: bind list does not contain `~/.claude` wildcard mount | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/skill-mount.test.ts` | Wave 0 |
| SKILL-03 | `--add-dir` flags appear in generated shell command | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/agent.test.ts` | ✅ (extend) |
| SKILL-03 | No `--add-dir` flags when `noSkills=true` | unit | same | Wave 0 |
| SKILL-04 | WORKFLOW.md with `skills:` parses to `WorkflowFileConfig.skills` | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/workflow-file.test.ts` | ✅ (extend) |
| SKILL-04 | WORKFLOW.md without `skills:` yields empty/undefined skills | unit | same | ✅ (extend) |
| SKILL-05 | `WorkflowSchema.parse({ skills: ["a","b"] })` succeeds | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/config.test.ts` | ✅ (extend) |
| SKILL-05 | `WorkflowFrontMatterSchema` accepts `skills` key (not rejected as unknown) | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/workflow-file.test.ts` | ✅ (extend) |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/skill-mount.test.ts`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/skill-mount.test.ts` — covers SKILL-01, SKILL-02, SKILL-03 (new file)
- [ ] Extend `test/unit/workflow-file.test.ts` — add `skills` field cases for SKILL-04, SKILL-05
- [ ] Extend `test/unit/config.test.ts` — add `WorkflowSchema` skills field case for SKILL-05
- [ ] Extend `test/unit/agent.test.ts` or `workflow-resolver.test.ts` — verify `--add-dir` flags in `buildShellCommand()` output for SKILL-03

---

## Sources

### Primary (HIGH confidence)
- Direct code read: `src/auth/mount.ts` — ContainerMounts interface, prepareClaudeMounts() OAuth path
- Direct code read: `src/config/schema.ts` — WorkflowSchema, Zod patterns
- Direct code read: `src/workflow/workflow-file.ts` — WorkflowFrontMatterSchema strict schema
- Direct code read: `src/workflow/types.ts` — WorkflowFileConfig interface, RunPlan
- Direct code read: `src/orchestration/single.ts` — prepareExecution() bind assembly, agentOptions.flags
- Direct code read: `src/agent/claude-code.ts` — buildShellCommand(), flags iteration, shellEscape()
- Direct code read: `src/agent/types.ts` — AgentOptions interface
- Direct code read: `src/workflow/resolver.ts` — resolveRunPlan(), CLIOptions
- Direct code read: `src/index.ts` — CLI option registration pattern
- Direct code read: `tsconfig.json` — noUnusedLocals, noUnusedParameters constraints
- Direct code read: `test/unit/workflow-file.test.ts` — existing test patterns to extend

### Secondary (MEDIUM confidence)
- `.planning/phases/26-skill-config-bind-mounting/26-CONTEXT.md` — all architectural decisions (locked and discretionary)
- `.planning/REQUIREMENTS.md` — SKILL-01 through SKILL-05 requirement text

### Tertiary (LOW confidence)
- Claude Code `--add-dir` flag behavior (not verified against official Claude Code docs) — use as specified in CONTEXT.md

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries are existing project dependencies, confirmed by source reads
- Architecture: HIGH — integration points are exact lines in existing code, confirmed by direct inspection
- Pitfalls: HIGH — derived from actual code constraints (`.strict()` schema, `shellEscape()` behavior, `noUnusedLocals`)
- `--add-dir` flag semantics: LOW — specified in CONTEXT.md but not verified against Claude Code documentation

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (stable internal codebase, no external dependency changes)
