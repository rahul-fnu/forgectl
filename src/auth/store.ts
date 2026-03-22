import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SERVICE_NAME = "forgectl";

interface KeytarLike {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

// File-based fallback when keytar is unavailable (no libsecret on system)
class FileStore implements KeytarLike {
  private filePath: string;

  constructor() {
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    const dir = join(home, ".forgectl");
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, "credentials.json");
  }

  private load(): Record<string, Record<string, string>> {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf-8"));
    } catch {
      return {};
    }
  }

  private save(data: Record<string, Record<string, string>>): void {
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    const data = this.load();
    if (!data[service]) data[service] = {};
    data[service][account] = password;
    this.save(data);
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    const data = this.load();
    return data[service]?.[account] ?? null;
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    const data = this.load();
    if (!data[service]?.[account]) return false;
    delete data[service][account];
    this.save(data);
    return true;
  }

  async findCredentials(service: string): Promise<Array<{ account: string; password: string }>> {
    const data = this.load();
    const serviceData = data[service] ?? {};
    return Object.entries(serviceData).map(([account, password]) => ({ account, password }));
  }
}

async function loadStore(): Promise<KeytarLike> {
  try {
    const keytar = await import("keytar");
    // Verify keytar actually works by attempting a no-op read.
    // On systems without a secrets service (e.g., Docker, headless Linux),
    // keytar imports fine but throws at runtime.
    await keytar.default.getPassword("forgectl-probe", "test");
    return keytar.default;
  } catch {
    return new FileStore();
  }
}

const storePromise = loadStore();

export async function setCredential(provider: string, key: string, value: string): Promise<void> {
  const store = await storePromise;
  await store.setPassword(SERVICE_NAME, `${provider}:${key}`, value);
}

export async function getCredential(provider: string, key: string): Promise<string | null> {
  const store = await storePromise;
  return store.getPassword(SERVICE_NAME, `${provider}:${key}`);
}

export async function deleteCredential(provider: string, key: string): Promise<boolean> {
  const store = await storePromise;
  return store.deletePassword(SERVICE_NAME, `${provider}:${key}`);
}

export async function listCredentials(): Promise<Array<{ provider: string; key: string }>> {
  const store = await storePromise;
  const all = await store.findCredentials(SERVICE_NAME);
  return all.map(cred => {
    const [provider, key] = cred.account.split(":", 2);
    return { provider, key };
  });
}
