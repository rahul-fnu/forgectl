import type { RunEvent } from "../logging/events.js";

export interface StreamSubscriberOptions {
  daemonUrl: string;
  daemonToken?: string;
  runId: string;
  onEvent: (event: RunEvent) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

export class StreamSubscriber {
  private abortController: AbortController | null = null;
  private running = false;

  async subscribe(options: StreamSubscriberOptions): Promise<void> {
    const { daemonUrl, daemonToken, runId, onEvent, onError, onClose } = options;

    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();

    const tokenParam = daemonToken ? `?token=${encodeURIComponent(daemonToken)}` : "";
    const url = `${daemonUrl}/api/v1/runs/${encodeURIComponent(runId)}/stream${tokenParam}`;

    try {
      const response = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal: this.abortController.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event = JSON.parse(line.slice(6)) as RunEvent;
              onEvent(event);
            } catch {
              // skip malformed events
            }
          }
        }
      }
    } catch (err) {
      if (this.running && onError) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.running = false;
      onClose?.();
    }
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
  }
}
