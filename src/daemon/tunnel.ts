import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "../logging/logger.js";

export interface TunnelOptions {
  port: number;
  cloudflaredPath?: string;
  logger: Logger;
}

export interface TunnelHandle {
  url: string;
  stop: () => void;
}

/**
 * Start a cloudflared quick tunnel (no account required).
 * Spawns `cloudflared tunnel --url http://127.0.0.1:<port>` and
 * parses the assigned URL from stderr output.
 */
export function startTunnel(opts: TunnelOptions): Promise<TunnelHandle> {
  const bin = opts.cloudflaredPath || "cloudflared";
  const args = ["tunnel", "--url", `http://127.0.0.1:${opts.port}`];

  return new Promise<TunnelHandle>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(new Error(`Failed to spawn cloudflared: ${err}`));
      return;
    }

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        reject(new Error("Timed out waiting for cloudflared tunnel URL (30s)"));
      }
    }, 30_000);

    const urlPattern = /https:\/\/[a-zA-Z0-9\-]+\.trycloudflare\.com/;

    const handleData = (data: Buffer) => {
      const text = data.toString();
      if (resolved) return;
      const match = text.match(urlPattern);
      if (match) {
        resolved = true;
        clearTimeout(timeout);
        const tunnelUrl = match[0];
        opts.logger.info("tunnel", `Cloudflare tunnel active: ${tunnelUrl}`);
        resolve({
          url: tunnelUrl,
          stop: () => {
            child.kill();
          },
        });
      }
    };

    child.stdout?.on("data", handleData);
    child.stderr?.on("data", handleData);

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`cloudflared error: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited with code ${code} before providing a URL`));
      } else {
        opts.logger.info("tunnel", `cloudflared process exited (code ${code})`);
      }
    });
  });
}
