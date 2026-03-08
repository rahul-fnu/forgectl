import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ValidatedWorkflowFile } from "../../src/workflow/types.js";

// Mock fs/promises watch
const mockAbort = vi.fn();
vi.mock("node:fs/promises", () => {
  return {
    watch: vi.fn(),
  };
});

// Mock loadWorkflowFile
vi.mock("../../src/workflow/workflow-file.js", () => {
  return {
    loadWorkflowFile: vi.fn(),
  };
});

import { watch } from "node:fs/promises";
import { loadWorkflowFile } from "../../src/workflow/workflow-file.js";
import { WorkflowFileWatcher } from "../../src/workflow/watcher.js";

const mockWatch = vi.mocked(watch);
const mockLoadWorkflowFile = vi.mocked(loadWorkflowFile);

function makeConfig(model: string): ValidatedWorkflowFile {
  return {
    config: { agent: { model } },
    promptTemplate: "test template",
  };
}

// Helper to create a controllable async iterator simulating fs.watch
function createMockWatcher() {
  const events: Array<{ eventType: string; filename: string | null }> = [];
  let resolveNext: ((value: IteratorResult<{ eventType: string; filename: string | null }>) => void) | null = null;
  let done = false;

  const iterator = {
    next(): Promise<IteratorResult<{ eventType: string; filename: string | null }>> {
      if (done) return Promise.resolve({ value: undefined, done: true });
      const event = events.shift();
      if (event) return Promise.resolve({ value: event, done: false });
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    },
    return(): Promise<IteratorResult<{ eventType: string; filename: string | null }>> {
      done = true;
      if (resolveNext) {
        resolveNext({ value: undefined, done: true });
        resolveNext = null;
      }
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(e: unknown): Promise<IteratorResult<{ eventType: string; filename: string | null }>> {
      done = true;
      return Promise.reject(e);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  function emit(eventType: string, filename: string | null = "WORKFLOW.md") {
    const event = { eventType, filename };
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: event, done: false });
    } else {
      events.push(event);
    }
  }

  function close() {
    done = true;
    if (resolveNext) {
      resolveNext({ value: undefined, done: true });
      resolveNext = null;
    }
  }

  return { iterator, emit, close };
}

describe("WorkflowFileWatcher", () => {
  let watcher: WorkflowFileWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    watcher = new WorkflowFileWatcher({ debounceMs: 100 });
  });

  afterEach(() => {
    watcher.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls onReload callback when file changes", async () => {
    const config = makeConfig("claude-3");
    mockLoadWorkflowFile.mockResolvedValue(config);

    const mock = createMockWatcher();
    mockWatch.mockReturnValue(mock.iterator as unknown as ReturnType<typeof watch>);

    const onReload = vi.fn();
    const onWarning = vi.fn();

    // Start watcher (runs async, we don't await it)
    watcher.start("/test/WORKFLOW.md", { onReload, onWarning });

    // Allow the watch loop to start
    await vi.advanceTimersByTimeAsync(0);

    // Emit file change
    mock.emit("change");
    await vi.advanceTimersByTimeAsync(0);

    // Wait for debounce
    await vi.advanceTimersByTimeAsync(100);

    // Allow the load promise to resolve
    await vi.advanceTimersByTimeAsync(0);

    expect(onReload).toHaveBeenCalledWith(config);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("debounces multiple rapid changes into single reload", async () => {
    const config = makeConfig("claude-3");
    mockLoadWorkflowFile.mockResolvedValue(config);

    const mock = createMockWatcher();
    mockWatch.mockReturnValue(mock.iterator as unknown as ReturnType<typeof watch>);

    const onReload = vi.fn();
    const onWarning = vi.fn();

    watcher.start("/test/WORKFLOW.md", { onReload, onWarning });
    await vi.advanceTimersByTimeAsync(0);

    // Emit 3 rapid changes
    mock.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30);

    mock.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30);

    mock.emit("change");
    await vi.advanceTimersByTimeAsync(0);

    // Wait for debounce to fire
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    // Should only reload once
    expect(mockLoadWorkflowFile).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("keeps last good config when reload produces invalid YAML", async () => {
    const goodConfig = makeConfig("claude-3");
    mockLoadWorkflowFile
      .mockResolvedValueOnce(goodConfig)
      .mockRejectedValueOnce(new Error("Invalid YAML: unexpected tag"));

    const mock = createMockWatcher();
    mockWatch.mockReturnValue(mock.iterator as unknown as ReturnType<typeof watch>);

    const onReload = vi.fn();
    const onWarning = vi.fn();

    watcher.start("/test/WORKFLOW.md", { onReload, onWarning });
    await vi.advanceTimersByTimeAsync(0);

    // First change - valid
    mock.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    expect(onReload).toHaveBeenCalledWith(goodConfig);
    expect(watcher.getLastGoodConfig()).toBe(goodConfig);

    // Second change - invalid
    mock.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    // Last good config should still be the first one
    expect(watcher.getLastGoodConfig()).toBe(goodConfig);
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining("Invalid YAML"),
    );
  });

  it("keeps last good config when reload produces invalid schema", async () => {
    const goodConfig = makeConfig("claude-3");
    mockLoadWorkflowFile
      .mockResolvedValueOnce(goodConfig)
      .mockRejectedValueOnce(new Error("Validation failed: unrecognized_keys"));

    const mock = createMockWatcher();
    mockWatch.mockReturnValue(mock.iterator as unknown as ReturnType<typeof watch>);

    const onReload = vi.fn();
    const onWarning = vi.fn();

    watcher.start("/test/WORKFLOW.md", { onReload, onWarning });
    await vi.advanceTimersByTimeAsync(0);

    // First valid change
    mock.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    // Second invalid change
    mock.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    expect(watcher.getLastGoodConfig()).toBe(goodConfig);
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining("Validation failed"),
    );
  });

  it("calls onWarning with error message on invalid reload", async () => {
    mockLoadWorkflowFile.mockRejectedValue(
      new Error("Parse error: bad content"),
    );

    const mock = createMockWatcher();
    mockWatch.mockReturnValue(mock.iterator as unknown as ReturnType<typeof watch>);

    const onReload = vi.fn();
    const onWarning = vi.fn();

    watcher.start("/test/WORKFLOW.md", { onReload, onWarning });
    await vi.advanceTimersByTimeAsync(0);

    mock.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining("Parse error: bad content"),
    );
    expect(onReload).not.toHaveBeenCalled();
  });

  it("stop() prevents further reloads", async () => {
    const config = makeConfig("claude-3");
    mockLoadWorkflowFile.mockResolvedValue(config);

    const mock = createMockWatcher();
    mockWatch.mockReturnValue(mock.iterator as unknown as ReturnType<typeof watch>);

    const onReload = vi.fn();
    const onWarning = vi.fn();

    watcher.start("/test/WORKFLOW.md", { onReload, onWarning });
    await vi.advanceTimersByTimeAsync(0);

    // Stop the watcher
    watcher.stop();

    // Emit after stop
    mock.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    expect(onReload).not.toHaveBeenCalled();
  });

  it("getLastGoodConfig() returns null when no config loaded yet", () => {
    expect(watcher.getLastGoodConfig()).toBeNull();
  });

  it("getLastGoodConfig() returns most recent valid config", async () => {
    const config1 = makeConfig("claude-3");
    const config2 = makeConfig("gpt-4");
    mockLoadWorkflowFile
      .mockResolvedValueOnce(config1)
      .mockResolvedValueOnce(config2);

    const mock = createMockWatcher();
    mockWatch.mockReturnValue(mock.iterator as unknown as ReturnType<typeof watch>);

    const onReload = vi.fn();
    const onWarning = vi.fn();

    watcher.start("/test/WORKFLOW.md", { onReload, onWarning });
    await vi.advanceTimersByTimeAsync(0);

    // First change
    mock.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    expect(watcher.getLastGoodConfig()).toBe(config1);

    // Second change
    mock.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    expect(watcher.getLastGoodConfig()).toBe(config2);
  });
});
