# TASK: Add Codex OAuth Session Support

Add support for Codex CLI's ChatGPT OAuth login flow alongside the existing API key method. This mirrors how Claude Code auth already works (API key OR OAuth session).

## Background

Codex CLI supports two auth methods:
1. **API key** — `OPENAI_API_KEY` env var (current implementation)
2. **ChatGPT OAuth** — user runs `codex login` on their machine, which stores credentials in `~/.codex/auth.json`. The entire `~/.codex/` directory (or `$CODEX_HOME`) contains auth.json + config.toml.

To use OAuth in a container, mount `~/.codex/` read-only and set `CODEX_HOME` to the mount path. Codex CLI picks up the cached session automatically.

## Files to Change

### 1. `src/auth/codex.ts`

Change `getCodexAuth()` from returning `Promise<string | null>` (just API key) to returning a typed auth object, exactly like `src/auth/claude.ts` does.

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCredential, setCredential } from "./store.js";

const PROVIDER = "codex";

export interface CodexAuth {
  type: "api_key" | "oauth_session";
  apiKey?: string;
  sessionDir?: string;    // Path to ~/.codex (contains auth.json, config.toml)
}

export async function getCodexAuth(): Promise<CodexAuth | null> {
  // Check for API key first
  const apiKey = await getCredential(PROVIDER, "api_key");
  if (apiKey) return { type: "api_key", apiKey };

  // Check for OAuth session (codex login stores credentials in ~/.codex/)
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const codexHome = process.env.CODEX_HOME || join(home, ".codex");
  const authJson = join(codexHome, "auth.json");
  if (existsSync(authJson)) return { type: "oauth_session", sessionDir: codexHome };

  return null;
}

export async function setCodexApiKey(key: string): Promise<void> {
  await setCredential(PROVIDER, "api_key", key);
}
```

### 2. `src/auth/mount.ts`

Change `prepareCodexMounts` to accept `CodexAuth` instead of a raw API key string. Handle both auth types:

- **API key**: same as before — write to temp file, mount as secret
- **OAuth session**: mount `sessionDir` to `/home/node/.codex:ro` and set `CODEX_HOME=/home/node/.codex` in env

```typescript
import type { CodexAuth } from "./codex.js";

export function prepareCodexMounts(auth: CodexAuth, runId: string): ContainerMounts {
  const secretsDir = join(tmpdir(), `forgectl-secrets-${runId}-${randomBytes(4).toString("hex")}`);
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const binds: string[] = [];
  const env: Record<string, string> = {};

  if (auth.type === "api_key" && auth.apiKey) {
    const keyPath = join(secretsDir, "openai_api_key");
    writeFileSync(keyPath, auth.apiKey, { mode: 0o400 });
    binds.push(`${secretsDir}:/run/secrets:ro`);
    env.OPENAI_API_KEY_FILE = "/run/secrets/openai_api_key";
  } else if (auth.type === "oauth_session" && auth.sessionDir) {
    // Mount the entire ~/.codex directory (contains auth.json + config.toml)
    binds.push(`${auth.sessionDir}:/home/node/.codex:ro`);
    env.CODEX_HOME = "/home/node/.codex";
  }

  return {
    binds,
    env,
    cleanup: () => { try { rmSync(secretsDir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}
```

### 3. `src/orchestration/single.ts`

Update the codex auth block (around line 82) to use the new `CodexAuth` type:

```typescript
// Replace this:
    } else {
      const apiKey = await getCodexAuth();
      if (!apiKey) throw new Error("No Codex credentials configured");
      const mounts = prepareCodexMounts(apiKey, plan.runId);
      binds.push(...mounts.binds);
      cleanup.secretCleanups.push(mounts.cleanup);
      agentEnv.push(`OPENAI_API_KEY=${apiKey}`);
    }

// With this:
    } else {
      const auth = await getCodexAuth();
      if (!auth) throw new Error("No Codex credentials configured. Run: codex login (OAuth) or forgectl auth add codex (API key)");
      const mounts = prepareCodexMounts(auth, plan.runId);
      binds.push(...mounts.binds);
      cleanup.secretCleanups.push(mounts.cleanup);
      if (auth.type === "api_key" && auth.apiKey) {
        agentEnv.push(`OPENAI_API_KEY=${auth.apiKey}`);
      }
      if (mounts.env.CODEX_HOME) {
        agentEnv.push(`CODEX_HOME=${mounts.env.CODEX_HOME}`);
      }
    }
```

### 4. `src/orchestration/review.ts`

Same pattern change in the `prepareReviewerCredentials` function (around line 104):

```typescript
// Replace this:
    const apiKey = await getCodexAuth();
    if (!apiKey) throw new Error("No Codex credentials configured for reviewer");
    const mounts = prepareCodexMounts(apiKey, `${runId}-reviewer-${round}`);
    binds.push(...mounts.binds);
    cleanup.secretCleanups.push(mounts.cleanup);
    agentEnv.push(`OPENAI_API_KEY=${apiKey}`);

// With this:
    const auth = await getCodexAuth();
    if (!auth) throw new Error("No Codex credentials configured for reviewer. Run: codex login (OAuth) or forgectl auth add codex (API key)");
    const mounts = prepareCodexMounts(auth, `${runId}-reviewer-${round}`);
    binds.push(...mounts.binds);
    cleanup.secretCleanups.push(mounts.cleanup);
    if (auth.type === "api_key" && auth.apiKey) {
      agentEnv.push(`OPENAI_API_KEY=${auth.apiKey}`);
    }
    if (mounts.env.CODEX_HOME) {
      agentEnv.push(`CODEX_HOME=${mounts.env.CODEX_HOME}`);
    }
```

### 5. `src/orchestration/preflight.ts`

Update the preflight error message (around line 38):

```typescript
// Replace:
      errors.push("No Codex credentials found. Run: forgectl auth add codex");
// With:
      errors.push("No Codex credentials found. Run: codex login (OAuth) or forgectl auth add codex (API key)");
```

### 6. `src/cli/auth.ts`

Update the `auth add codex` flow to detect existing OAuth sessions (mirror the claude-code pattern):

```typescript
    } else if (provider === "codex") {
      // Check for existing OAuth session first
      const { getCodexAuth } = await import("../auth/codex.js");
      const existing = await getCodexAuth();
      if (existing?.type === "oauth_session") {
        console.log(chalk.green("✔ Found existing Codex OAuth session at ~/.codex/"));
        console.log(chalk.gray("  (from 'codex login'). This will be used automatically."));
        const override = await prompt("Add an API key anyway? (y/N): ");
        if (override.toLowerCase() !== "y") return;
      }
      const key = await prompt("Enter your OpenAI API key: ");
      await setCodexApiKey(key);
      console.log(chalk.green("✔ Codex (OpenAI) API key saved."));
    }
```

Also add the `getCodexAuth` import at the top or use dynamic import as shown above.

## Verification

After making changes:

```bash
npm run typecheck   # Must pass clean
npm test            # All existing tests must pass
```

No new test files needed — the changes are small and the auth detection logic is straightforward (existsSync on a known path). The existing preflight tests may need minor updates if they mock getCodexAuth.

## Summary

6 files changed, all following the same pattern: replace raw `string` API key with `CodexAuth` union type that supports both `api_key` and `oauth_session`, exactly mirroring the existing `ClaudeAuth` pattern.
