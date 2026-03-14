import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { ClaudeAuth } from "./claude.js";
import type { CodexAuth } from "./codex.js";

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
    env.ANTHROPIC_API_KEY_FILE = "/run/secrets/anthropic_api_key";
  } else if (auth.type === "oauth_session" && auth.sessionDir) {
    binds.push(`${auth.sessionDir}:/home/node/.claude:ro`);
    // Claude Code also needs .claude.json (sibling of .claude dir) for config
    const claudeJsonPath = join(auth.sessionDir, "..", ".claude.json");
    if (existsSync(claudeJsonPath)) {
      // Copy to secrets dir so it's writable (Claude Code writes to it)
      const containerJsonPath = join(secretsDir, ".claude.json");
      const jsonContent = readFileSync(claudeJsonPath, "utf-8");
      writeFileSync(containerJsonPath, jsonContent, { mode: 0o600 });
      binds.push(`${containerJsonPath}:/home/node/.claude.json`);
    }
    env.HOME = "/home/node";
  }

  return {
    binds,
    env,
    cleanup: () => { try { rmSync(secretsDir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

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
    // Create a writable CODEX_HOME with auth.json copied in.
    // Codex needs to write skills cache, models cache, config, etc.
    // Mounting ~/.codex read-only breaks Codex (read-only FS errors).
    const codexHome = join(secretsDir, "codex-home");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });

    // Copy auth.json from host
    const authJson = readFileSync(join(auth.sessionDir, "auth.json"), "utf-8");
    writeFileSync(join(codexHome, "auth.json"), authJson, { mode: 0o600 });

    // Copy config.toml if it exists
    const configPath = join(auth.sessionDir, "config.toml");
    if (existsSync(configPath)) {
      const configToml = readFileSync(configPath, "utf-8");
      writeFileSync(join(codexHome, "config.toml"), configToml, { mode: 0o600 });
    }

    binds.push(`${codexHome}:/home/node/.codex`);
    env.CODEX_HOME = "/home/node/.codex";
  }

  return {
    binds,
    env,
    cleanup: () => { try { rmSync(secretsDir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}
