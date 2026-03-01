import type { CLIOptions } from "../workflow/resolver.js";
import type { ExecutionResult } from "../orchestration/single.js";

export type QueuedRunStatus = "queued" | "running" | "completed" | "failed";

export interface QueuedRun {
  id: string;
  options: CLIOptions;
  status: QueuedRunStatus;
  submittedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: ExecutionResult;
  error?: string;
}

export class RunQueue {
  private queue: QueuedRun[] = [];
  private running = false;
  private onExecute: (run: QueuedRun) => Promise<ExecutionResult>;

  constructor(onExecute: (run: QueuedRun) => Promise<ExecutionResult>) {
    this.onExecute = onExecute;
  }

  submit(id: string, options: CLIOptions): QueuedRun {
    const run: QueuedRun = {
      id,
      options,
      status: "queued",
      submittedAt: new Date().toISOString(),
    };
    this.queue.push(run);
    // Trigger processing asynchronously
    void this.processNext();
    return run;
  }

  get(id: string): QueuedRun | undefined {
    return this.queue.find(r => r.id === id);
  }

  list(): QueuedRun[] {
    return [...this.queue];
  }

  private async processNext(): Promise<void> {
    if (this.running) return;
    const next = this.queue.find(r => r.status === "queued");
    if (!next) return;

    this.running = true;
    next.status = "running";
    next.startedAt = new Date().toISOString();

    try {
      next.result = await this.onExecute(next);
      next.status = next.result.success ? "completed" : "failed";
    } catch (err) {
      next.status = "failed";
      next.error = err instanceof Error ? err.message : String(err);
    } finally {
      next.completedAt = new Date().toISOString();
      this.running = false;
      void this.processNext();
    }
  }
}
