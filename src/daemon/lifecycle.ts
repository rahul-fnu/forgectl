import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const FORGECTL_DIR = join(process.env.HOME || "/tmp", ".forgectl");
const PID_FILE = join(FORGECTL_DIR, "daemon.pid");

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
