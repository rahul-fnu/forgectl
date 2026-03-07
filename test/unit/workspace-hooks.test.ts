import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process before importing the module
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { executeHook } from "../../src/workspace/hooks.js";

const mockExecFile = vi.mocked(execFile);

describe("executeHook", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("runs command with cwd set to workspace path", async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await executeHook("after_create", "echo hello", "/workspace", 60000);

    expect(mockExecFile).toHaveBeenCalledWith(
      "/bin/sh",
      ["-c", "echo hello"],
      expect.objectContaining({ cwd: "/workspace", timeout: 60000 }),
      expect.any(Function),
    );
  });

  it("resolves without error on success", async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, "output", "");
      return undefined as any;
    });

    await expect(
      executeHook("before_run", "npm install", "/workspace", 60000),
    ).resolves.toBeUndefined();
  });

  it("throws with hook name, exit code, and stderr on failure", async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err: any = new Error("Command failed");
      err.code = 1;
      err.stderr = "some error output";
      err.killed = false;
      cb(err);
      return undefined as any;
    });

    await expect(
      executeHook("before_run", "npm test", "/workspace", 60000),
    ).rejects.toThrow(/Hook "before_run" failed \(exit 1\): some error output/);
  });

  it("throws with timed out message when killed", async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err: any = new Error("Command timed out");
      err.killed = true;
      err.code = null;
      err.stderr = "";
      cb(err);
      return undefined as any;
    });

    await expect(
      executeHook("after_run", "sleep 999", "/workspace", 5000),
    ).rejects.toThrow(/Hook "after_run" timed out after 5000ms/);
  });

  it("truncates stderr to 500 chars", async () => {
    const longStderr = "x".repeat(1000);
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err: any = new Error("Command failed");
      err.code = 1;
      err.stderr = longStderr;
      err.killed = false;
      cb(err);
      return undefined as any;
    });

    try {
      await executeHook("before_run", "bad-cmd", "/workspace", 60000);
      expect.unreachable("should have thrown");
    } catch (e: any) {
      // stderr in the message should be at most 500 chars
      const match = e.message.match(/\): (.+)$/);
      expect(match).toBeTruthy();
      expect(match![1].length).toBeLessThanOrEqual(500);
    }
  });
});
