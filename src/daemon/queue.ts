import type { CLIOptions } from "../workflow/resolver.js";
import type { ExecutionResult } from "../orchestration/single.js";
import type { RunRepository, RunRow } from "../storage/repositories/runs.js";

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

function rowToQueuedRun(row: RunRow): QueuedRun {
  return {
    id: row.id,
    options: (row.options as CLIOptions) ?? { task: row.task },
    status: row.status as QueuedRunStatus,
    submittedAt: row.submittedAt,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    result: (row.result as ExecutionResult) ?? undefined,
    error: row.error ?? undefined,
  };
}

export class RunQueue {
  private running = false;
  private repo: RunRepository;
  private onExecute: (run: QueuedRun) => Promise<ExecutionResult>;

  constructor(repo: RunRepository, onExecute: (run: QueuedRun) => Promise<ExecutionResult>) {
    this.repo = repo;
    this.onExecute = onExecute;
  }

  submit(id: string, options: CLIOptions): QueuedRun {
    const submittedAt = new Date().toISOString();
    const row = this.repo.insert({
      id,
      task: options.task,
      workflow: options.workflow,
      options,
      status: "queued",
      submittedAt,
    });
    // Trigger processing asynchronously
    void this.processNext();
    return rowToQueuedRun(row);
  }

  get(id: string): QueuedRun | undefined {
    const row = this.repo.findById(id);
    return row ? rowToQueuedRun(row) : undefined;
  }

  list(): QueuedRun[] {
    return this.repo.list().map(rowToQueuedRun);
  }

  private async processNext(): Promise<void> {
    if (this.running) return;
    const queued = this.repo.findByStatus("queued");
    const next = queued[0];
    if (!next) return;

    this.running = true;
    const startedAt = new Date().toISOString();
    this.repo.updateStatus(next.id, { status: "running", startedAt });
    const run = rowToQueuedRun({ ...next, status: "running", startedAt });

    try {
      const result = await this.onExecute(run);
      const status = result.success ? "completed" : "failed";
      this.repo.updateStatus(next.id, {
        status,
        completedAt: new Date().toISOString(),
        result,
      });
    } catch (err) {
      this.repo.updateStatus(next.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running = false;
      void this.processNext();
    }
  }
}
