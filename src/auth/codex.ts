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
