import { eq, and } from "drizzle-orm";
import Docker from "dockerode";
import type { AppDatabase } from "../storage/database.js";
import { offlineQueue, pendingPrs } from "../storage/schema.js";
import type { Logger } from "../logging/logger.js";

export type ServiceName = "linear" | "discord" | "github";
export type QueueItemStatus = "pending" | "flushed" | "failed";
export type PendingPrStatus = "pending" | "created" | "failed";

export interface QueueItem {
  id: number;
  service: ServiceName;
  operation: string;
  payload: unknown;
  status: QueueItemStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  flushedAt: string | null;
}

export interface PendingPr {
  id: number;
  repo: string;
  branch: string;
  title: string;
  body: string | null;
  baseBranch: string;
  status: PendingPrStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export type FlushHandler = (item: QueueItem) => Promise<void>;
export type PrFlushHandler = (pr: PendingPr) => Promise<void>;

export class OfflineQueue {
  private db: AppDatabase;
  private logger: Logger;
  private flushHandlers = new Map<ServiceName, FlushHandler>();
  private prFlushHandler: PrFlushHandler | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dockerCheckTimer: ReturnType<typeof setInterval> | null = null;
  private dockerPaused = false;
  private onDockerPause?: () => void;
  private onDockerResume?: () => void;
  private maxAttempts: number;

  constructor(
    db: AppDatabase,
    logger: Logger,
    opts?: {
      maxAttempts?: number;
      onDockerPause?: () => void;
      onDockerResume?: () => void;
    },
  ) {
    this.db = db;
    this.logger = logger;
    this.maxAttempts = opts?.maxAttempts ?? 5;
    this.onDockerPause = opts?.onDockerPause;
    this.onDockerResume = opts?.onDockerResume;
  }

  enqueue(service: ServiceName, operation: string, payload: unknown): number {
    const result = this.db
      .insert(offlineQueue)
      .values({
        service,
        operation,
        payload: JSON.stringify(payload),
        status: "pending",
        attempts: 0,
        createdAt: new Date().toISOString(),
      })
      .returning({ id: offlineQueue.id })
      .get();

    this.logger.info("offline-queue", `Queued ${service}/${operation} (id=${result.id})`);
    return result.id;
  }

  enqueuePr(pr: { repo: string; branch: string; title: string; body?: string; baseBranch?: string }): number {
    const result = this.db
      .insert(pendingPrs)
      .values({
        repo: pr.repo,
        branch: pr.branch,
        title: pr.title,
        body: pr.body ?? null,
        baseBranch: pr.baseBranch ?? "main",
        status: "pending",
        attempts: 0,
        createdAt: new Date().toISOString(),
      })
      .returning({ id: pendingPrs.id })
      .get();

    this.logger.info("offline-queue", `Queued pending PR for ${pr.repo}:${pr.branch} (id=${result.id})`);
    return result.id;
  }

  registerFlushHandler(service: ServiceName, handler: FlushHandler): void {
    this.flushHandlers.set(service, handler);
  }

  registerPrFlushHandler(handler: PrFlushHandler): void {
    this.prFlushHandler = handler;
  }

  getPending(service?: ServiceName): QueueItem[] {
    const rows = service
      ? this.db.select().from(offlineQueue).where(and(eq(offlineQueue.status, "pending"), eq(offlineQueue.service, service))).all()
      : this.db.select().from(offlineQueue).where(eq(offlineQueue.status, "pending")).all();

    return rows.map(this.toQueueItem);
  }

  getPendingPrs(): PendingPr[] {
    return this.db
      .select()
      .from(pendingPrs)
      .where(eq(pendingPrs.status, "pending"))
      .all()
      .map(this.toPendingPr);
  }

  async flush(service?: ServiceName): Promise<{ flushed: number; failed: number }> {
    let flushed = 0;
    let failed = 0;

    const items = this.getPending(service);
    for (const item of items) {
      const handler = this.flushHandlers.get(item.service);
      if (!handler) continue;

      try {
        await handler(item);
        this.db
          .update(offlineQueue)
          .set({ status: "flushed", flushedAt: new Date().toISOString() })
          .where(eq(offlineQueue.id, item.id))
          .run();
        flushed++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const newAttempts = item.attempts + 1;
        const newStatus = newAttempts >= this.maxAttempts ? "failed" : "pending";
        this.db
          .update(offlineQueue)
          .set({ attempts: newAttempts, lastError: errMsg, status: newStatus })
          .where(eq(offlineQueue.id, item.id))
          .run();
        if (newStatus === "failed") {
          this.logger.error("offline-queue", `Item ${item.id} (${item.service}/${item.operation}) permanently failed after ${newAttempts} attempts: ${errMsg}`);
        }
        failed++;
      }
    }

    // Flush pending PRs
    const prs = this.getPendingPrs();
    for (const pr of prs) {
      if (!this.prFlushHandler) continue;
      try {
        await this.prFlushHandler(pr);
        this.db
          .update(pendingPrs)
          .set({ status: "created", resolvedAt: new Date().toISOString() })
          .where(eq(pendingPrs.id, pr.id))
          .run();
        flushed++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const newAttempts = pr.attempts + 1;
        const newStatus = newAttempts >= this.maxAttempts ? "failed" : "pending";
        this.db
          .update(pendingPrs)
          .set({ attempts: newAttempts, lastError: errMsg, status: newStatus })
          .where(eq(pendingPrs.id, pr.id))
          .run();
        if (newStatus === "failed") {
          this.logger.error("offline-queue", `Pending PR ${pr.id} (${pr.repo}:${pr.branch}) permanently failed after ${newAttempts} attempts: ${errMsg}`);
        }
        failed++;
      }
    }

    if (flushed > 0 || failed > 0) {
      this.logger.info("offline-queue", `Flush complete: ${flushed} flushed, ${failed} failed`);
    }

    return { flushed, failed };
  }

  startPeriodicFlush(intervalMs = 30_000): void {
    this.stopPeriodicFlush();
    this.flushTimer = setInterval(() => {
      void this.flush().catch((err) => {
        this.logger.error("offline-queue", `Periodic flush error: ${err}`);
      });
    }, intervalMs);
  }

  stopPeriodicFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  startDockerHealthCheck(intervalMs = 15_000): void {
    this.stopDockerHealthCheck();
    this.dockerCheckTimer = setInterval(() => {
      void this.checkDockerHealth();
    }, intervalMs);
    // Run an immediate check
    void this.checkDockerHealth();
  }

  stopDockerHealthCheck(): void {
    if (this.dockerCheckTimer) {
      clearInterval(this.dockerCheckTimer);
      this.dockerCheckTimer = null;
    }
  }

  isDockerPaused(): boolean {
    return this.dockerPaused;
  }

  async checkDockerHealth(): Promise<boolean> {
    try {
      const docker = new Docker();
      await docker.ping();
      if (this.dockerPaused) {
        this.dockerPaused = false;
        this.logger.info("offline-queue", "Docker recovered — resuming scheduler");
        this.onDockerResume?.();
      }
      return true;
    } catch {
      if (!this.dockerPaused) {
        this.dockerPaused = true;
        this.logger.warn("offline-queue", "Docker unavailable — pausing scheduler");
        this.onDockerPause?.();
      }
      return false;
    }
  }

  async checkServiceHealth(service: ServiceName): Promise<boolean> {
    try {
      switch (service) {
        case "github": {
          const resp = await fetch("https://api.github.com/zen", { signal: AbortSignal.timeout(5000) });
          return resp.ok;
        }
        case "discord": {
          const resp = await fetch("https://discord.com/api/v10/gateway", { signal: AbortSignal.timeout(5000) });
          return resp.ok;
        }
        case "linear": {
          const resp = await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: "{ __typename }" }),
            signal: AbortSignal.timeout(5000),
          });
          return resp.status !== 503 && resp.status !== 502;
        }
        default:
          return true;
      }
    } catch {
      return false;
    }
  }

  stop(): void {
    this.stopPeriodicFlush();
    this.stopDockerHealthCheck();
  }

  private toQueueItem(row: typeof offlineQueue.$inferSelect): QueueItem {
    return {
      id: row.id!,
      service: row.service as ServiceName,
      operation: row.operation,
      payload: JSON.parse(row.payload),
      status: row.status as QueueItemStatus,
      attempts: row.attempts,
      lastError: row.lastError,
      createdAt: row.createdAt,
      flushedAt: row.flushedAt,
    };
  }

  private toPendingPr(row: typeof pendingPrs.$inferSelect): PendingPr {
    return {
      id: row.id!,
      repo: row.repo,
      branch: row.branch,
      title: row.title,
      body: row.body,
      baseBranch: row.baseBranch,
      status: row.status as PendingPrStatus,
      attempts: row.attempts,
      lastError: row.lastError,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
    };
  }
}
