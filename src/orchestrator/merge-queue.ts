/**
 * Sequential merge queue that serializes PR merges (one at a time).
 * Prevents parallel branches from corrupting shared files.
 */

export interface MergeRequest {
  branch: string;
  prNumber: number;
  resolve: (result: MergeResult) => void;
}

export interface MergeResult {
  merged: boolean;
  error?: string;
}

export type MergeFn = (prNumber: number, branch: string) => Promise<void>;

export class MergeQueue {
  private queue: MergeRequest[] = [];
  private processing = false;

  constructor(private readonly mergeFn: MergeFn) {}

  /**
   * Enqueue a PR for sequential merge processing.
   * Returns a promise that resolves when the PR has been processed.
   */
  enqueue(branch: string, prNumber: number): Promise<MergeResult> {
    return new Promise<MergeResult>((resolve) => {
      this.queue.push({ branch, prNumber, resolve });
      void this.processNext();
    });
  }

  /**
   * Process the next item in the queue. Only one merge runs at a time.
   */
  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const request = this.queue.shift()!;

    try {
      await this.mergeFn(request.prNumber, request.branch);
      request.resolve({ merged: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Failed merge — PR left open, queue moves to next item
      request.resolve({ merged: false, error: message });
    }

    this.processing = false;
    // Process next item in queue
    void this.processNext();
  }

  /** Number of items waiting in the queue (not including currently processing). */
  get pending(): number {
    return this.queue.length;
  }

  /** Whether a merge is currently being processed. */
  get isProcessing(): boolean {
    return this.processing;
  }
}
