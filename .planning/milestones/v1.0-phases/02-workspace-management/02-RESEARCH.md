# Phase 2: Workspace Management - Research

**Researched:** 2026-03-07
**Domain:** Filesystem workspace lifecycle, path safety, shell hook execution
**Confidence:** HIGH

## Summary

Phase 2 implements a per-issue workspace manager that creates, reuses, and removes directories under a configurable root path. Each workspace is named by a sanitized issue identifier and supports lifecycle hooks (after_create, before_run, after_run, before_remove) with configurable timeouts and well-defined failure semantics.

This is a standalone module (`src/workspace/`) separate from the existing `src/container/workspace.ts` (which handles ephemeral temp dirs for Docker container mounting). The new module manages persistent, per-issue directories that survive across runs. Node.js built-in `fs` and `child_process` APIs cover all requirements -- no external libraries needed.

**Primary recommendation:** Use `node:fs/promises` for all filesystem operations, `node:child_process.execFile` for hook execution with AbortController-based timeouts, and `node:path.resolve` + startsWith checks for path containment validation.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Reuse workspace as-is on retry/continuation -- agent picks up where it stopped. before_run hook can reset state if needed
- Delete workspace only when tracker issue reaches terminal state (closed/done). Successful runs keep workspace for potential follow-up
- Startup cleanup: fetch terminal-state issues from tracker, delete only their workspaces. Leave others untouched
- Log which workspaces are being deleted before removal -- provides audit trail without blocking
- Manager creates the directory; hooks handle all setup (clone, install, etc.)
- after_create hook is the customization point -- manager is unopinionated about what goes in the workspace
- before_run hook failure: throw error with hook name, exit code, and stderr output. Orchestrator catches and decides retry/release
- after_create failure: abort -- workspace is in unknown state
- after_run failure: log and ignore -- work is already done
- before_remove failure: log and ignore -- cleanup proceeds
- Validate path containment on every operation (create, get, remove) -- defense in depth
- Identifier sanitization: replace non-`[A-Za-z0-9._-]` with `_`
- Path traversal attempts throw with descriptive error message

### Claude's Discretion
- Hook execution mechanism (child_process.exec vs spawn)
- Workspace config schema design (how hooks are specified in config)
- Internal workspace state tracking (Map vs filesystem checks)
- Whether to use fs.rm or rimraf for cleanup

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| R3.1 | Workspace lifecycle: configurable root, per-issue dirs, create/reuse/cleanup | Core manager module with sanitizeIdentifier, ensureWorkspace, removeWorkspace |
| R3.2 | Workspace hooks: after_create, before_run, after_run, before_remove with failure semantics | Hook executor with timeout, cwd, and per-hook error handling policy |
| R3.3 | Workspace safety: path containment, identifier sanitization, cwd validation | Safety module with assertContainment, sanitizeIdentifier |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| node:fs/promises | built-in | Async filesystem ops (mkdir, rm, stat, readdir) | Project uses async/await everywhere per CLAUDE.md |
| node:path | built-in | Path resolution, joining, containment checks | Standard for all path operations per CLAUDE.md |
| node:child_process | built-in | Hook execution via execFile | No external dependency needed for shell commands |
| zod | existing dep | Config schema for workspace section | Project convention: all config validated with zod |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:os | built-in | homedir() for default workspace root | Resolving `~/.forgectl/workspaces/` default path |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| fs.rm | rimraf (npm) | fs.rm with `recursive: true, force: true` covers all cases since Node 14.14+. No need for rimraf. |
| child_process.exec | execa (npm) | exec/execFile is sufficient for running hook commands with timeout. No need for extra dependency. |

**Installation:**
```bash
# No new dependencies required -- all Node.js built-ins + existing zod
```

## Architecture Patterns

### Recommended Project Structure
```
src/workspace/
  manager.ts       # WorkspaceManager: create, get, remove, cleanupTerminal
  hooks.ts         # executeHook(): run shell commands with timeout/cwd
  safety.ts        # sanitizeIdentifier(), assertContainment()
  index.ts         # Barrel export
```

### Pattern 1: WorkspaceManager Class
**What:** Stateless manager that derives workspace paths from config + identifier. Uses filesystem as source of truth (no in-memory Map).
**When to use:** All workspace operations.
**Rationale:** Filesystem-as-truth is simpler, survives daemon restarts, and avoids sync issues. The `existsSync` check on `ensureWorkspace` determines create-vs-reuse. This aligns with the project's "file-based state, recover from tracker on restart" decision.

```typescript
export interface WorkspaceConfig {
  root: string;           // e.g. "~/.forgectl/workspaces"
  hooks?: {
    after_create?: string;
    before_run?: string;
    after_run?: string;
    before_remove?: string;
  };
  hook_timeout?: string;  // duration like "60s", default "60s"
}

export interface WorkspaceInfo {
  path: string;
  identifier: string;
  created: boolean;  // true if just created, false if reused
}

export class WorkspaceManager {
  constructor(private config: WorkspaceConfig, private logger: Logger) {}

  async ensureWorkspace(identifier: string): Promise<WorkspaceInfo> {
    const sanitized = sanitizeIdentifier(identifier);
    const wsPath = resolve(this.resolvedRoot, sanitized);
    assertContainment(this.resolvedRoot, wsPath);

    const exists = await pathExists(wsPath);
    if (!exists) {
      await mkdir(wsPath, { recursive: true });
      if (this.config.hooks?.after_create) {
        await executeHook("after_create", this.config.hooks.after_create, wsPath, this.timeout);
        // failure throws -- caller handles
      }
      return { path: wsPath, identifier: sanitized, created: true };
    }
    return { path: wsPath, identifier: sanitized, created: false };
  }

  async removeWorkspace(identifier: string): Promise<void> {
    const sanitized = sanitizeIdentifier(identifier);
    const wsPath = resolve(this.resolvedRoot, sanitized);
    assertContainment(this.resolvedRoot, wsPath);

    if (this.config.hooks?.before_remove) {
      try {
        await executeHook("before_remove", this.config.hooks.before_remove, wsPath, this.timeout);
      } catch (err) {
        this.logger.warn("workspace", `before_remove hook failed: ${err}, proceeding with removal`);
      }
    }
    this.logger.info("workspace", `Removing workspace: ${wsPath}`);
    await rm(wsPath, { recursive: true, force: true });
  }
}
```

### Pattern 2: Hook Execution with Timeout
**What:** Execute shell command with cwd set to workspace, using AbortController for timeout.
**When to use:** All hook invocations.

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function executeHook(
  hookName: string,
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<void> {
  const controller = new AbortController();
  try {
    await execFileAsync("/bin/sh", ["-c", command], {
      cwd,
      signal: controller.signal,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1MB
    });
  } catch (err: unknown) {
    const e = err as { code?: number | string; stderr?: string; killed?: boolean };
    if (e.killed) {
      throw new Error(`Hook "${hookName}" timed out after ${timeoutMs}ms`);
    }
    throw new Error(
      `Hook "${hookName}" failed (exit ${e.code}): ${(e.stderr || "").trim().slice(0, 500)}`
    );
  }
}
```

**Why execFile with /bin/sh -c:** Hooks are user-defined shell commands (e.g., `git clone ... && npm install`). Using `execFile("/bin/sh", ["-c", cmd])` avoids shell injection from the command string while still supporting pipes/redirects. The `timeout` option on execFile handles cleanup (sends SIGTERM then SIGKILL).

### Pattern 3: Path Containment Validation
**What:** Resolve both root and target path, verify target starts with root.
**When to use:** Every workspace operation (defense in depth per user decision).

```typescript
import { resolve, sep } from "node:path";

export function assertContainment(root: string, target: string): void {
  const resolvedRoot = resolve(root) + sep;
  const resolvedTarget = resolve(target);
  if (!resolvedTarget.startsWith(resolvedRoot) && resolvedTarget !== resolve(root)) {
    throw new Error(`Path traversal detected: "${target}" escapes workspace root "${root}"`);
  }
}

export function sanitizeIdentifier(identifier: string): string {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  if (sanitized.length === 0) {
    throw new Error(`Identifier "${identifier}" sanitizes to empty string`);
  }
  // Prevent dot-only identifiers that could resolve to parent dirs
  if (sanitized === "." || sanitized === "..") {
    throw new Error(`Identifier "${identifier}" sanitizes to "${sanitized}" which is unsafe`);
  }
  return sanitized;
}
```

### Anti-Patterns to Avoid
- **In-memory workspace tracking:** Using a Map to track created workspaces creates sync issues on restart. Use filesystem existence checks instead.
- **path.join for containment:** `path.join(root, "../escape")` normalizes to parent. Always use `resolve()` + `startsWith()` after sanitization for defense in depth.
- **Synchronous fs operations in manager:** The existing `src/container/workspace.ts` uses sync fs. The new workspace manager should use async ops (project convention: async/await everywhere).
- **Custom error classes:** Project uses plain Error with descriptive messages (established pattern from Phase 1).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Directory removal | Recursive delete with manual traversal | `fs.rm(path, { recursive: true, force: true })` | Handles symlinks, permissions, edge cases. Available since Node 14.14 |
| Shell command timeout | Manual setTimeout + process.kill | `execFile` with `timeout` option | Handles SIGTERM/SIGKILL cascade, child process cleanup |
| Path resolution | String concatenation or manual normalization | `path.resolve()` + `path.sep` | Handles all OS edge cases, symlinks, relative paths |
| Duration parsing | Custom regex parser | Existing project `parseDuration()` utility or the `duration` zod schema already in config/schema.ts | Already exists in codebase |

## Common Pitfalls

### Pitfall 1: TOCTOU on Workspace Existence
**What goes wrong:** Check if directory exists, then create -- race condition if two dispatches for same issue happen simultaneously.
**Why it happens:** Async operations between check and create.
**How to avoid:** Use `mkdir` with `recursive: true` which is atomic at the OS level. If it already exists, no error. Check the `created` flag by catching EEXIST or using a stat after mkdir.
**Warning signs:** Duplicate after_create hook invocations for the same workspace.

### Pitfall 2: Tilde Expansion in Root Path
**What goes wrong:** `~/.forgectl/workspaces` is not expanded by Node.js path functions.
**Why it happens:** Tilde expansion is a shell feature, not a filesystem feature.
**How to avoid:** Replace leading `~` with `os.homedir()` when resolving the root path.
**Warning signs:** Workspace created at literal `~/` directory relative to cwd.

### Pitfall 3: Hook Zombie Processes
**What goes wrong:** Hook spawns child processes that outlive the timeout kill.
**Why it happens:** `execFile` timeout kills the direct child, but not its process group.
**How to avoid:** Pass `{ killSignal: "SIGTERM" }` and consider process group kill. For v1, the timeout option on execFile is sufficient -- advanced process group management is a future concern.
**Warning signs:** Orphan processes consuming resources after hook timeout.

### Pitfall 4: Containment Check with Symlinks
**What goes wrong:** Symlink inside workspace root points outside root. `resolve()` follows symlinks.
**Why it happens:** User-created symlinks in workspace or hook-created symlinks.
**How to avoid:** Use `fs.realpath()` on both root and target before comparison if symlink attacks are a concern. For v1, `resolve()` is sufficient since we control the root and sanitize identifiers.
**Warning signs:** Workspace operations touching files outside root.

### Pitfall 5: Empty or Dot-Only Identifiers
**What goes wrong:** Identifier like `...` sanitizes to `...` or identifier of only special chars sanitizes to empty string.
**Why it happens:** Sanitization regex replaces everything.
**How to avoid:** Check for empty result and reject `.` / `..` after sanitization.
**Warning signs:** Workspace created at root or parent directory.

## Code Examples

### Config Schema Extension
```typescript
// Add to src/config/schema.ts
export const WorkspaceConfigSchema = z.object({
  root: z.string().default("~/.forgectl/workspaces"),
  hooks: z.object({
    after_create: z.string().optional(),
    before_run: z.string().optional(),
    after_run: z.string().optional(),
    before_remove: z.string().optional(),
  }).default({}),
  hook_timeout: duration.default("60s"),
}).default({});

// Add to ConfigSchema:
// workspace: WorkspaceConfigSchema,
```

### Hook Execution with Failure Semantics
```typescript
// In manager.ts -- showing before_run and after_run contrast
async runBeforeHook(identifier: string): Promise<void> {
  const wsPath = this.getWorkspacePath(identifier);
  if (this.config.hooks?.before_run) {
    // before_run failure THROWS -- caller (orchestrator) decides what to do
    await executeHook("before_run", this.config.hooks.before_run, wsPath, this.timeout);
  }
}

async runAfterHook(identifier: string): Promise<void> {
  const wsPath = this.getWorkspacePath(identifier);
  if (this.config.hooks?.after_run) {
    try {
      await executeHook("after_run", this.config.hooks.after_run, wsPath, this.timeout);
    } catch (err) {
      // after_run failure is LOGGED AND IGNORED -- work is already done
      this.logger.warn("workspace", `after_run hook failed for ${identifier}: ${err}`);
    }
  }
}
```

### Startup Cleanup Pattern
```typescript
// Called by orchestrator on startup
async cleanupTerminalWorkspaces(terminalIdentifiers: string[]): Promise<void> {
  const root = this.resolvedRoot;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return; // Root doesn't exist yet -- nothing to clean
  }

  const terminalSet = new Set(terminalIdentifiers.map(sanitizeIdentifier));
  for (const entry of entries) {
    if (terminalSet.has(entry)) {
      this.logger.info("workspace", `Cleaning up terminal workspace: ${entry}`);
      await this.removeWorkspace(entry);
    }
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| rimraf for recursive delete | `fs.rm(path, { recursive: true, force: true })` | Node.js 14.14 (2020) | No npm dependency needed |
| Manual timeout with setTimeout | `execFile` with `timeout` option | Node.js 0.12+ | Cleaner, handles signal cascade |
| `fs.existsSync` for existence | `fs.access` or `fs.stat` (async) | Always available | Async consistency, though existsSync is fine for simple checks |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (existing) |
| Config file | `vitest.config.ts` (exists) |
| Quick run command | `npx vitest run test/unit/workspace.test.ts` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| R3.1-a | Create workspace with sanitized identifier | unit | `npx vitest run test/unit/workspace.test.ts -t "create"` | No -- Wave 0 |
| R3.1-b | Reuse existing workspace (not recreated) | unit | `npx vitest run test/unit/workspace.test.ts -t "reuse"` | No -- Wave 0 |
| R3.1-c | Remove workspace for terminal issues | unit | `npx vitest run test/unit/workspace.test.ts -t "remove"` | No -- Wave 0 |
| R3.1-d | Startup cleanup of terminal workspaces | unit | `npx vitest run test/unit/workspace.test.ts -t "cleanup"` | No -- Wave 0 |
| R3.2-a | after_create runs only on first creation | unit | `npx vitest run test/unit/workspace-hooks.test.ts -t "after_create"` | No -- Wave 0 |
| R3.2-b | before_run failure aborts attempt | unit | `npx vitest run test/unit/workspace-hooks.test.ts -t "before_run"` | No -- Wave 0 |
| R3.2-c | after_run failure logged and ignored | unit | `npx vitest run test/unit/workspace-hooks.test.ts -t "after_run"` | No -- Wave 0 |
| R3.2-d | before_remove failure logged and ignored | unit | `npx vitest run test/unit/workspace-hooks.test.ts -t "before_remove"` | No -- Wave 0 |
| R3.2-e | Hook timeout kills process | unit | `npx vitest run test/unit/workspace-hooks.test.ts -t "timeout"` | No -- Wave 0 |
| R3.3-a | Path traversal rejected | unit | `npx vitest run test/unit/workspace-safety.test.ts -t "traversal"` | No -- Wave 0 |
| R3.3-b | Identifier sanitization | unit | `npx vitest run test/unit/workspace-safety.test.ts -t "sanitize"` | No -- Wave 0 |
| R3.3-c | Dot-only and empty identifiers rejected | unit | `npx vitest run test/unit/workspace-safety.test.ts -t "edge"` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run test/unit/workspace*.test.ts`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/workspace.test.ts` -- covers R3.1 (create/reuse/remove/cleanup)
- [ ] `test/unit/workspace-hooks.test.ts` -- covers R3.2 (hook lifecycle, timeout, failure semantics)
- [ ] `test/unit/workspace-safety.test.ts` -- covers R3.3 (sanitization, containment, edge cases)

Testing approach: Use real filesystem with `mkdtempSync` for workspace root (matching `board-store.test.ts` pattern). Mock `child_process.execFile` for hook tests to avoid actual shell execution. Clean up temp dirs in `afterEach`.

## Open Questions

1. **Hook environment variables**
   - What we know: Hooks run with workspace as cwd. No specific env vars mentioned in requirements.
   - What's unclear: Should hooks receive issue metadata as env vars (e.g., FORGECTL_ISSUE_ID)?
   - Recommendation: Start simple -- cwd only. Add env vars in Phase 5 integration if needed.

2. **Concurrent workspace operations**
   - What we know: Orchestrator has concurrency control (R2.3). One agent per issue at a time.
   - What's unclear: Can two removeWorkspace calls race on startup cleanup?
   - Recommendation: `fs.rm` with `force: true` is idempotent -- concurrent removes are safe. No locking needed.

## Sources

### Primary (HIGH confidence)
- Node.js `fs/promises` API (built-in, stable since Node 10+)
- Node.js `child_process.execFile` with timeout option (built-in, stable)
- Existing project code: `src/container/workspace.ts`, `src/config/schema.ts`, `src/tracker/types.ts`
- Existing test patterns: `test/unit/board-store.test.ts` (real filesystem with temp dirs)

### Secondary (MEDIUM confidence)
- Node.js `path.resolve` + `startsWith` for containment (well-documented pattern)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all Node.js built-ins, no new dependencies
- Architecture: HIGH -- patterns follow existing project conventions, straightforward module
- Pitfalls: HIGH -- well-known filesystem/process pitfalls, documented in Node.js docs

**Research date:** 2026-03-07
**Valid until:** 2026-04-07 (stable domain, no fast-moving dependencies)
