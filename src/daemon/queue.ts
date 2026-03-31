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
  private runs = new Map<string, QueuedRun>();
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
    this.runs.set(id, run);
    void this.processNext();
    return run;
  }

  get(id: string): QueuedRun | undefined {
    return this.runs.get(id);
  }

  list(): QueuedRun[] {
    return [...this.runs.values()];
  }

  private async processNext(): Promise<void> {
    if (this.running) return;
    const next = [...this.runs.values()].find(r => r.status === "queued");
    if (!next) return;

    this.running = true;
    next.status = "running";
    next.startedAt = new Date().toISOString();

    try {
      const result = await this.onExecute(next);
      next.status = result.success ? "completed" : "failed";
      next.completedAt = new Date().toISOString();
      next.result = result;
    } catch (err) {
      next.status = "failed";
      next.completedAt = new Date().toISOString();
      next.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.running = false;
      void this.processNext();
    }
  }
}
