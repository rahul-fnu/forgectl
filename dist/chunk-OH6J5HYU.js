#!/usr/bin/env node

// src/auth/codex.ts
import { existsSync as existsSync2 } from "fs";
import { join as join2 } from "path";

// src/auth/store.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
var SERVICE_NAME = "forgectl";
var FileStore = class {
  filePath;
  constructor() {
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    const dir = join(home, ".forgectl");
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, "credentials.json");
  }
  load() {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf-8"));
    } catch {
      return {};
    }
  }
  save(data) {
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 384 });
  }
  async setPassword(service, account, password) {
    const data = this.load();
    if (!data[service]) data[service] = {};
    data[service][account] = password;
    this.save(data);
  }
  async getPassword(service, account) {
    const data = this.load();
    return data[service]?.[account] ?? null;
  }
  async deletePassword(service, account) {
    const data = this.load();
    if (!data[service]?.[account]) return false;
    delete data[service][account];
    this.save(data);
    return true;
  }
  async findCredentials(service) {
    const data = this.load();
    const serviceData = data[service] ?? {};
    return Object.entries(serviceData).map(([account, password]) => ({ account, password }));
  }
};
async function loadStore() {
  try {
    const keytar = await import("keytar");
    return keytar.default;
  } catch {
    return new FileStore();
  }
}
var storePromise = loadStore();
async function setCredential(provider, key, value) {
  const store = await storePromise;
  await store.setPassword(SERVICE_NAME, `${provider}:${key}`, value);
}
async function getCredential(provider, key) {
  const store = await storePromise;
  return store.getPassword(SERVICE_NAME, `${provider}:${key}`);
}
async function deleteCredential(provider, key) {
  const store = await storePromise;
  return store.deletePassword(SERVICE_NAME, `${provider}:${key}`);
}
async function listCredentials() {
  const store = await storePromise;
  const all = await store.findCredentials(SERVICE_NAME);
  return all.map((cred) => {
    const [provider, key] = cred.account.split(":", 2);
    return { provider, key };
  });
}

// src/auth/codex.ts
var PROVIDER = "codex";
async function getCodexAuth() {
  const apiKey = await getCredential(PROVIDER, "api_key");
  if (apiKey) return { type: "api_key", apiKey };
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const codexHome = process.env.CODEX_HOME || join2(home, ".codex");
  const authJson = join2(codexHome, "auth.json");
  if (existsSync2(authJson)) return { type: "oauth_session", sessionDir: codexHome };
  return null;
}
async function setCodexApiKey(key) {
  await setCredential(PROVIDER, "api_key", key);
}

export {
  setCredential,
  getCredential,
  deleteCredential,
  listCredentials,
  getCodexAuth,
  setCodexApiKey
};
//# sourceMappingURL=chunk-OH6J5HYU.js.map