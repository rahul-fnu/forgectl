/**
 * Merge daemon API routes — observability endpoints.
 */

import type { FastifyInstance } from "fastify";
import type { PRProcessor } from "./pr-processor.js";

export interface MergeDaemonStatus {
  status: "running" | "idle";
  currentPR: number | null;
  queueLength: number;
  pollIntervalMs: number;
  uptimeMs: number;
}

export function registerMergeDaemonRoutes(
  app: FastifyInstance,
  getStatus: () => MergeDaemonStatus,
  processor: PRProcessor,
): void {
  app.get("/health", async () => ({
    status: "ok",
    service: "merge-daemon",
    timestamp: new Date().toISOString(),
  }));

  app.get("/api/v1/status", async () => getStatus());

  app.get("/api/v1/queue", async () => {
    try {
      const prs = await processor.fetchOpenForgePRs();
      return { count: prs.length, prs };
    } catch (err) {
      return { count: 0, prs: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get("/api/v1/history", async () => processor.getHistory());
}
