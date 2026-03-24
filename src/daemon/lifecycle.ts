import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const FORGECTL_DIR = join(process.env.HOME || "/tmp", ".forgectl");
const PID_FILE = join(FORGECTL_DIR, "daemon.pid");
const TOKEN_FILE = join(FORGECTL_DIR, "daemon.token");

export function savePid(pid: number): void {
  mkdirSync(FORGECTL_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(pid));
}

export function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, "utf-8").trim();
  const pid = parseInt(raw, 10);
  if (isNaN(pid)) return null;
  // Check if process is actually running
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    unlinkSync(PID_FILE);
    return null;
  }
}

export function removePid(): void {
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

export function isDaemonRunning(): boolean {
  return readPid() !== null;
}

export function generateAndSaveToken(): string {
  mkdirSync(FORGECTL_DIR, { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

export function readDaemonToken(): string | null {
  if (!existsSync(TOKEN_FILE)) return null;
  return readFileSync(TOKEN_FILE, "utf-8").trim();
}

export function removeToken(): void {
  try { unlinkSync(TOKEN_FILE); } catch { /* ignore */ }
}
