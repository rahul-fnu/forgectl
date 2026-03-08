import { watch } from "node:fs/promises";
import { loadWorkflowFile } from "./workflow-file.js";
import type { ValidatedWorkflowFile } from "./types.js";

export interface WatcherCallbacks {
  onReload: (config: ValidatedWorkflowFile) => void;
  onWarning: (message: string) => void;
}

export interface WatcherOptions {
  debounceMs?: number;
}

/**
 * Watches a WORKFLOW.md file for changes with debounced reload.
 * Keeps last-known-good config on invalid reload and emits warnings.
 */
export class WorkflowFileWatcher {
  private debounceMs: number;
  private lastGoodConfig: ValidatedWorkflowFile | null = null;
  private abortController: AbortController | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(options: WatcherOptions = {}) {
    this.debounceMs = options.debounceMs ?? 300;
  }

  /**
   * Start watching a file for changes.
   * Calls onReload with new config on successful reload.
   * Calls onWarning with error message on invalid reload.
   */
  async start(
    filePath: string,
    callbacks: WatcherCallbacks,
  ): Promise<void> {
    this.stopped = false;
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    try {
      const watcher = watch(filePath, { signal });

      for await (const _event of watcher) {
        if (this.stopped) break;

        // Debounce: clear previous timer and set new one
        if (this.debounceTimer !== null) {
          clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
          void this.reload(filePath, callbacks);
        }, this.debounceMs);
      }
    } catch (err: unknown) {
      // AbortError is expected when stop() is called
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      throw err;
    }
  }

  /**
   * Stop watching the file. Clears pending debounce timer.
   */
  stop(): void {
    this.stopped = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Returns the last successfully parsed config, or null if none yet.
   */
  getLastGoodConfig(): ValidatedWorkflowFile | null {
    return this.lastGoodConfig;
  }

  private async reload(
    filePath: string,
    callbacks: WatcherCallbacks,
  ): Promise<void> {
    if (this.stopped) return;

    try {
      const config = await loadWorkflowFile(filePath);
      this.lastGoodConfig = config;
      callbacks.onReload(config);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err);
      callbacks.onWarning(
        `WORKFLOW.md reload failed: ${message}`,
      );
    }
  }
}
