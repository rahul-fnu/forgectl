import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/workspace/hooks.js", () => ({
  executeHook: vi.fn().mockResolvedValue(undefined),
}));

import { WorkspaceManager } from "../../src/workspace/manager.js";
import { executeHook } from "../../src/workspace/hooks.js";
import type { Logger } from "../../src/logging/logger.js";

const mockedExecuteHook = vi.mocked(executeHook);

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    onEntry: vi.fn(),
    getEntries: vi.fn().mockReturnValue([]),
  } as unknown as Logger;
}

describe("WorkspaceManager", () => {
  let tmpRoot: string;
  let logger: Logger;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "ws-test-"));
    logger = makeLogger();
    mockedExecuteHook.mockReset();
    mockedExecuteHook.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe("ensureWorkspace", () => {
    it("creates directory and returns created: true for new workspace", async () => {
      const mgr = new WorkspaceManager(
        { root: tmpRoot, hooks: {}, hook_timeout: "60s" },
        logger,
      );
      const result = await mgr.ensureWorkspace("issue-1");
      expect(result.created).toBe(true);
      expect(result.identifier).toBe("issue-1");
      expect(existsSync(result.path)).toBe(true);
    });

    it("returns created: false when workspace already exists", async () => {
      const mgr = new WorkspaceManager(
        { root: tmpRoot, hooks: {}, hook_timeout: "60s" },
        logger,
      );
      await mgr.ensureWorkspace("issue-1");
      const result = await mgr.ensureWorkspace("issue-1");
      expect(result.created).toBe(false);
    });

    it("calls after_create hook only when created=true", async () => {
      const mgr = new WorkspaceManager(
        { root: tmpRoot, hooks: { after_create: "echo created" }, hook_timeout: "60s" },
        logger,
      );
      await mgr.ensureWorkspace("issue-2");
      expect(mockedExecuteHook).toHaveBeenCalledTimes(1);
      expect(mockedExecuteHook).toHaveBeenCalledWith(
        "after_create",
        "echo created",
        expect.stringContaining("issue-2"),
        60000,
      );
    });

    it("does NOT call after_create when reusing", async () => {
      const mgr = new WorkspaceManager(
        { root: tmpRoot, hooks: { after_create: "echo created" }, hook_timeout: "60s" },
        logger,
      );
      await mgr.ensureWorkspace("issue-3");
      mockedExecuteHook.mockReset();
      mockedExecuteHook.mockResolvedValue(undefined);
      await mgr.ensureWorkspace("issue-3");
      expect(mockedExecuteHook).not.toHaveBeenCalled();
    });

    it("propagates after_create hook failure", async () => {
      mockedExecuteHook.mockRejectedValueOnce(new Error("hook failed"));
      const mgr = new WorkspaceManager(
        { root: tmpRoot, hooks: { after_create: "fail" }, hook_timeout: "60s" },
        logger,
      );
      await expect(mgr.ensureWorkspace("issue-4")).rejects.toThrow("hook failed");
    });
  });

  describe("runBeforeHook", () => {
    it("calls before_run hook; failure throws", async () => {
      const mgr = new WorkspaceManager(
        { root: tmpRoot, hooks: { before_run: "check" }, hook_timeout: "30s" },
        logger,
      );
      await mgr.ensureWorkspace("ws-1");
      mockedExecuteHook.mockReset();
      mockedExecuteHook.mockRejectedValueOnce(new Error("before_run failed"));
      await expect(mgr.runBeforeHook("ws-1")).rejects.toThrow("before_run failed");
    });
  });

  describe("runAfterHook", () => {
    it("calls after_run hook; failure is logged, does not throw", async () => {
      const mgr = new WorkspaceManager(
        { root: tmpRoot, hooks: { after_run: "cleanup" }, hook_timeout: "30s" },
        logger,
      );
      await mgr.ensureWorkspace("ws-2");
      mockedExecuteHook.mockReset();
      mockedExecuteHook.mockRejectedValueOnce(new Error("after_run oops"));
      await expect(mgr.runAfterHook("ws-2")).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe("removeWorkspace", () => {
    it("calls before_remove hook (failure logged, ignored), then deletes directory", async () => {
      const mgr = new WorkspaceManager(
        { root: tmpRoot, hooks: { before_remove: "bye" }, hook_timeout: "60s" },
        logger,
      );
      const ws = await mgr.ensureWorkspace("ws-del");
      mockedExecuteHook.mockReset();
      mockedExecuteHook.mockRejectedValueOnce(new Error("remove hook fail"));
      await mgr.removeWorkspace("ws-del");
      expect(existsSync(ws.path)).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });

    it("logs which workspace is being deleted", async () => {
      const mgr = new WorkspaceManager(
        { root: tmpRoot, hooks: {}, hook_timeout: "60s" },
        logger,
      );
      await mgr.ensureWorkspace("ws-log");
      await mgr.removeWorkspace("ws-log");
      expect(logger.info).toHaveBeenCalledWith(
        "workspace",
        expect.stringContaining("ws-log"),
        expect.anything(),
      );
    });
  });

  describe("cleanupTerminalWorkspaces", () => {
    it("removes only workspaces matching terminal identifiers", async () => {
      const mgr = new WorkspaceManager(
        { root: tmpRoot, hooks: {}, hook_timeout: "60s" },
        logger,
      );
      await mgr.ensureWorkspace("active-1");
      await mgr.ensureWorkspace("done-2");
      await mgr.ensureWorkspace("active-3");
      await mgr.cleanupTerminalWorkspaces(["done-2"]);
      expect(existsSync(path.join(tmpRoot, "active-1"))).toBe(true);
      expect(existsSync(path.join(tmpRoot, "done-2"))).toBe(false);
      expect(existsSync(path.join(tmpRoot, "active-3"))).toBe(true);
    });

    it("handles missing root directory gracefully", async () => {
      const mgr = new WorkspaceManager(
        { root: path.join(tmpRoot, "nonexistent"), hooks: {}, hook_timeout: "60s" },
        logger,
      );
      await expect(mgr.cleanupTerminalWorkspaces(["x"])).resolves.toBeUndefined();
    });
  });

  describe("tilde expansion", () => {
    it("expands ~ in root path to homedir", () => {
      const mgr = new WorkspaceManager(
        { root: "~/.forgectl/workspaces", hooks: {}, hook_timeout: "60s" },
        logger,
      );
      const wsPath = mgr.getWorkspacePath("test-id");
      expect(wsPath).toContain(os.homedir());
      expect(wsPath).not.toContain("~");
    });
  });

  describe("path containment", () => {
    it("all operations call assertContainment", async () => {
      const mgr = new WorkspaceManager(
        { root: tmpRoot, hooks: {}, hook_timeout: "60s" },
        logger,
      );
      // Path traversal attempt
      await expect(mgr.ensureWorkspace("../../etc")).rejects.toThrow();
    });
  });
});
