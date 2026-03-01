import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { ClaudeAuth } from "./claude.js";

export interface ContainerMounts {
  binds: string[];                   // Docker bind mount strings
  env: Record<string, string>;       // Env vars to set in agent process
  cleanup: () => void;               // Call after run to wipe temp files
}

export function prepareClaudeMounts(auth: ClaudeAuth, runId: string): ContainerMounts {
  const secretsDir = join(tmpdir(), `forgectl-secrets-${runId}-${randomBytes(4).toString("hex")}`);
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const binds: string[] = [];
  const env: Record<string, string> = {};

  if (auth.type === "api_key" && auth.apiKey) {
    const keyPath = join(secretsDir, "anthropic_api_key");
    writeFileSync(keyPath, auth.apiKey, { mode: 0o400 });
    binds.push(`${secretsDir}:/run/secrets:ro`);
    // Env injection happens at exec time: ANTHROPIC_API_KEY=$(cat /run/secrets/anthropic_api_key)
    env.ANTHROPIC_API_KEY_FILE = "/run/secrets/anthropic_api_key";
  } else if (auth.type === "oauth_session" && auth.sessionDir) {
    binds.push(`${auth.sessionDir}:/home/node/.claude:ro`);
  }

  return {
    binds,
    env,
    cleanup: () => { try { rmSync(secretsDir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

export function prepareCodexMounts(apiKey: string, runId: string): ContainerMounts {
  const secretsDir = join(tmpdir(), `forgectl-secrets-${runId}-${randomBytes(4).toString("hex")}`);
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

  const keyPath = join(secretsDir, "openai_api_key");
  writeFileSync(keyPath, apiKey, { mode: 0o400 });

  return {
    binds: [`${secretsDir}:/run/secrets:ro`],
    env: { OPENAI_API_KEY_FILE: "/run/secrets/openai_api_key" },
    cleanup: () => { try { rmSync(secretsDir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}
