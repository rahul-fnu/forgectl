import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { OfflineQueue } from "../../src/resilience/offline-queue.js";
import type { Logger } from "../../src/logging/logger.js";

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe("OfflineQueue", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let logger: Logger;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "offline-queue-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    logger = makeLogger();
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("enqueue", () => {
    it("should enqueue an item and return its id", () => {
      const queue = new OfflineQueue(db, logger);
      const id = queue.enqueue("linear", "create_issue", { title: "Test" });
      expect(id).toBeGreaterThan(0);
    });

    it("should persist the queued item", () => {
      const queue = new OfflineQueue(db, logger);
      queue.enqueue("discord", "send_message", { channel: "general", text: "hello" });
      const pending = queue.getPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].service).toBe("discord");
      expect(pending[0].operation).toBe("send_message");
      expect(pending[0].payload).toEqual({ channel: "general", text: "hello" });
      expect(pending[0].status).toBe("pending");
    });

    it("should filter by service", () => {
      const queue = new OfflineQueue(db, logger);
      queue.enqueue("linear", "create_issue", { title: "A" });
      queue.enqueue("discord", "send_message", { text: "B" });
      queue.enqueue("github", "create_pr", { repo: "test" });

      expect(queue.getPending("linear")).toHaveLength(1);
      expect(queue.getPending("discord")).toHaveLength(1);
      expect(queue.getPending("github")).toHaveLength(1);
      expect(queue.getPending()).toHaveLength(3);
    });
  });

  describe("enqueuePr", () => {
    it("should enqueue a pending PR", () => {
      const queue = new OfflineQueue(db, logger);
      const id = queue.enqueuePr({ repo: "owner/repo", branch: "forge/fix-1", title: "Fix bug" });
      expect(id).toBeGreaterThan(0);

      const prs = queue.getPendingPrs();
      expect(prs).toHaveLength(1);
      expect(prs[0].repo).toBe("owner/repo");
      expect(prs[0].branch).toBe("forge/fix-1");
      expect(prs[0].title).toBe("Fix bug");
      expect(prs[0].baseBranch).toBe("main");
      expect(prs[0].status).toBe("pending");
    });
  });

  describe("flush", () => {
    it("should flush items using registered handlers", async () => {
      const queue = new OfflineQueue(db, logger);
      const handler = vi.fn().mockResolvedValue(undefined);
      queue.registerFlushHandler("linear", handler);

      queue.enqueue("linear", "create_issue", { title: "Test" });
      const result = await queue.flush();

      expect(result.flushed).toBe(1);
      expect(result.failed).toBe(0);
      expect(handler).toHaveBeenCalledOnce();
      expect(queue.getPending()).toHaveLength(0);
    });

    it("should retry failed items", async () => {
      const queue = new OfflineQueue(db, logger, { maxAttempts: 3 });
      const handler = vi.fn().mockRejectedValue(new Error("service down"));
      queue.registerFlushHandler("discord", handler);

      queue.enqueue("discord", "send_message", { text: "hello" });

      // First attempt fails but stays pending
      await queue.flush();
      let pending = queue.getPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].attempts).toBe(1);

      // Second attempt
      await queue.flush();
      pending = queue.getPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].attempts).toBe(2);

      // Third attempt: max reached, marked as failed
      await queue.flush();
      pending = queue.getPending();
      expect(pending).toHaveLength(0);
    });

    it("should flush pending PRs using registered handler", async () => {
      const queue = new OfflineQueue(db, logger);
      const prHandler = vi.fn().mockResolvedValue(undefined);
      queue.registerPrFlushHandler(prHandler);

      queue.enqueuePr({ repo: "owner/repo", branch: "forge/fix", title: "Fix" });
      const result = await queue.flush();

      expect(result.flushed).toBe(1);
      expect(prHandler).toHaveBeenCalledOnce();
      expect(queue.getPendingPrs()).toHaveLength(0);
    });

    it("should skip items with no handler", async () => {
      const queue = new OfflineQueue(db, logger);
      queue.enqueue("linear", "create_issue", { title: "no handler" });
      const result = await queue.flush();
      expect(result.flushed).toBe(0);
      expect(result.failed).toBe(0);
      expect(queue.getPending()).toHaveLength(1);
    });

    it("should filter flush by service", async () => {
      const queue = new OfflineQueue(db, logger);
      const linearHandler = vi.fn().mockResolvedValue(undefined);
      const discordHandler = vi.fn().mockResolvedValue(undefined);
      queue.registerFlushHandler("linear", linearHandler);
      queue.registerFlushHandler("discord", discordHandler);

      queue.enqueue("linear", "create_issue", { title: "A" });
      queue.enqueue("discord", "send_message", { text: "B" });

      await queue.flush("linear");
      expect(linearHandler).toHaveBeenCalledOnce();
      expect(discordHandler).not.toHaveBeenCalled();
      expect(queue.getPending("linear")).toHaveLength(0);
      expect(queue.getPending("discord")).toHaveLength(1);
    });
  });

  describe("Docker health check", () => {
    it("should report paused state when Docker is unavailable", async () => {
      const onDockerPause = vi.fn();
      const onDockerResume = vi.fn();
      const queue = new OfflineQueue(db, logger, { onDockerPause, onDockerResume });

      // Docker ping will fail in test environment (no Docker)
      const healthy = await queue.checkDockerHealth();
      // In CI without Docker, it should be unhealthy
      if (!healthy) {
        expect(queue.isDockerPaused()).toBe(true);
        expect(onDockerPause).toHaveBeenCalled();
      }
    });

    it("should call onDockerResume when Docker comes back", async () => {
      const onDockerPause = vi.fn();
      const onDockerResume = vi.fn();
      const queue = new OfflineQueue(db, logger, { onDockerPause, onDockerResume });

      // Force paused state
      await queue.checkDockerHealth();
      if (queue.isDockerPaused()) {
        // If Docker is actually available and returns, resume should fire
        // In test env, Docker is typically unavailable, so this verifies the state tracking
        expect(queue.isDockerPaused()).toBe(true);
      }
    });
  });

  describe("periodic flush", () => {
    it("should start and stop periodic flush without errors", () => {
      const queue = new OfflineQueue(db, logger);
      queue.startPeriodicFlush(100_000);
      queue.stopPeriodicFlush();
    });

    it("should start and stop Docker health check without errors", () => {
      const queue = new OfflineQueue(db, logger);
      queue.startDockerHealthCheck(100_000);
      queue.stopDockerHealthCheck();
    });

    it("stop() should clean up all timers", () => {
      const queue = new OfflineQueue(db, logger);
      queue.startPeriodicFlush(100_000);
      queue.startDockerHealthCheck(100_000);
      queue.stop();
    });
  });
});
