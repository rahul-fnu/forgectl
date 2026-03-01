import { getCredential, setCredential } from "./store.js";

const PROVIDER = "codex";

export async function getCodexAuth(): Promise<string | null> {
  return getCredential(PROVIDER, "api_key");
}

export async function setCodexApiKey(key: string): Promise<void> {
  await setCredential(PROVIDER, "api_key", key);
}
