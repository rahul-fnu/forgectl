import { rmSync } from "node:fs";
import Docker from "dockerode";
import { destroyContainer } from "./runner.js";
import { removeNetwork } from "./network.js";

export interface CleanupContext {
  container?: Docker.Container;
  networkName?: string;
  tempDirs: string[];
  secretCleanups: Array<() => void>;
}

export async function cleanupRun(ctx: CleanupContext): Promise<void> {
  if (ctx.container) {
    await destroyContainer(ctx.container);
  }
  if (ctx.networkName) {
    await removeNetwork(ctx.networkName);
  }
  for (const dir of ctx.tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  for (const fn of ctx.secretCleanups) {
    try { fn(); } catch { /* ignore */ }
  }
}
