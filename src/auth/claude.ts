import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCredential, setCredential } from "./store.js";

const PROVIDER = "claude-code";

export interface ClaudeAuth {
  type: "api_key" | "oauth_session";
  apiKey?: string;
  sessionDir?: string;
}

export async function getClaudeAuth(): Promise<ClaudeAuth | null> {
  // Check for API key first
  const apiKey = await getCredential(PROVIDER, "api_key");
  if (apiKey) return { type: "api_key", apiKey };

  // Check for OAuth session
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const claudeDir = join(home, ".claude");
  if (existsSync(claudeDir)) return { type: "oauth_session", sessionDir: claudeDir };

  return null;
}

export async function setClaudeApiKey(key: string): Promise<void> {
  await setCredential(PROVIDER, "api_key", key);
}
