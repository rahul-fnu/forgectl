import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";

const FORGECTL_DIR = join(process.env.HOME || "/tmp", ".forgectl");
const TUNNEL_PID_FILE = join(FORGECTL_DIR, "tunnel.pid");
const TUNNEL_URL_FILE = join(FORGECTL_DIR, "tunnel.url");

export function parseTunnelUrl(output: string): string | null {
  const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
  return match ? match[0] : null;
}

function readTunnelPid(): number | null {
  if (!existsSync(TUNNEL_PID_FILE)) return null;
  const raw = readFileSync(TUNNEL_PID_FILE, "utf-8").trim();
  const pid = parseInt(raw, 10);
  if (isNaN(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    try { unlinkSync(TUNNEL_PID_FILE); } catch { /* ignore */ }
    try { unlinkSync(TUNNEL_URL_FILE); } catch { /* ignore */ }
    return null;
  }
}

function readTunnelUrl(): string | null {
  if (!existsSync(TUNNEL_URL_FILE)) return null;
  return readFileSync(TUNNEL_URL_FILE, "utf-8").trim() || null;
}

export async function tunnelStartCommand(opts: { port: string }): Promise<void> {
  const existing = readTunnelPid();
  if (existing) {
    const url = readTunnelUrl();
    console.log(`Tunnel already running (PID ${existing})${url ? `: ${url}` : ""}`);
    return;
  }

  const port = parseInt(opts.port, 10);

  // Check if cloudflared is installed
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("cloudflared", ["--version"], { stdio: "ignore" });
  } catch {
    console.error(
      chalk.red("cloudflared not found.") +
      " Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    );
    process.exit(1);
  }

  const child = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (!child.pid) {
    console.error("Failed to start cloudflared tunnel.");
    process.exit(1);
  }

  mkdirSync(FORGECTL_DIR, { recursive: true });
  writeFileSync(TUNNEL_PID_FILE, String(child.pid));

  // Parse the tunnel URL from stderr (cloudflared logs to stderr)
  const url = await new Promise<string | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), 15000);
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const found = parseTunnelUrl(buffer);
      if (found) {
        clearTimeout(timeout);
        child.stderr!.removeListener("data", onData);
        child.stdout!.removeListener("data", onStdoutData);
        resolve(found);
      }
    };

    let stdoutBuffer = "";
    const onStdoutData = (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const found = parseTunnelUrl(stdoutBuffer);
      if (found) {
        clearTimeout(timeout);
        child.stderr!.removeListener("data", onData);
        child.stdout!.removeListener("data", onStdoutData);
        resolve(found);
      }
    };

    child.stderr!.on("data", onData);
    child.stdout!.on("data", onStdoutData);
  });

  child.unref();

  if (url) {
    writeFileSync(TUNNEL_URL_FILE, url);
    console.log(chalk.green(`Tunnel started: ${url}`));
  } else {
    console.log(chalk.yellow("Tunnel started but could not detect URL."));
  }
  console.log(`PID: ${child.pid}`);
}

export async function tunnelStopCommand(): Promise<void> {
  const pid = readTunnelPid();
  if (!pid) {
    console.log("No tunnel running.");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopped tunnel (PID ${pid})`);
  } catch {
    console.error(`Failed to stop tunnel (PID ${pid})`);
  }
  try { unlinkSync(TUNNEL_PID_FILE); } catch { /* ignore */ }
  try { unlinkSync(TUNNEL_URL_FILE); } catch { /* ignore */ }
}

export async function tunnelStatusCommand(): Promise<void> {
  const pid = readTunnelPid();
  if (!pid) {
    console.log("Tunnel: not running");
    return;
  }
  const url = readTunnelUrl();
  console.log(`Tunnel: running (PID ${pid})`);
  if (url) {
    console.log(`URL: ${url}`);
  }
}
