import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatRunEvent, mergeMessages, formatCostSummary, DiscordRunStream } from "../../src/discord/stream.js";
import type { DiscordMessage, DiscordPoster } from "../../src/discord/stream.js";
import type { RunEvent } from "../../src/logging/events.js";
import { emitRunEvent } from "../../src/logging/events.js";

function makeEvent(overrides: Partial<RunEvent> & { type: RunEvent["type"] }): RunEvent {
  return {
    runId: "run-1",
    timestamp: "2026-03-29T00:00:00Z",
    data: {},
    ...overrides,
  };
}

describe("formatRunEvent", () => {
  it("formats agent_started", () => {
    const msg = formatRunEvent(makeEvent({ type: "agent_started" }));
    expect(msg).toEqual({ content: "Agent started working..." });
  });

  it("formats agent_started with prefix", () => {
    const msg = formatRunEvent(makeEvent({ type: "agent_started" }), "RAH-210");
    expect(msg?.content).toBe("[RAH-210] Agent started working...");
  });

  it("formats agent_output stderr with errors", () => {
    const msg = formatRunEvent(makeEvent({
      type: "agent_output",
      data: { stream: "stderr", chunk: "Error: module not found" },
    }));
    expect(msg?.content).toContain("```");
    expect(msg?.content).toContain("Error: module not found");
  });

  it("ignores agent_output stdout", () => {
    const msg = formatRunEvent(makeEvent({
      type: "agent_output",
      data: { stream: "stdout", chunk: "some output" },
    }));
    expect(msg).toBeNull();
  });

  it("ignores agent_output stderr without error keywords", () => {
    const msg = formatRunEvent(makeEvent({
      type: "agent_output",
      data: { stream: "stderr", chunk: "debug info here" },
    }));
    expect(msg).toBeNull();
  });

  it("truncates long agent_output", () => {
    const longChunk = "Error: " + "x".repeat(2000);
    const msg = formatRunEvent(makeEvent({
      type: "agent_output",
      data: { stream: "stderr", chunk: longChunk },
    }));
    expect(msg?.content).toContain("...(truncated)");
    expect(msg!.content!.length).toBeLessThan(2000);
  });

  it("formats validation_step_started", () => {
    const msg = formatRunEvent(makeEvent({
      type: "validation_step_started",
      data: { step: "npm test" },
    }));
    expect(msg).toEqual({ content: "Running: npm test..." });
  });

  it("formats validation_step_completed pass", () => {
    const msg = formatRunEvent(makeEvent({
      type: "validation_step_completed",
      data: { step: "npm test", passed: true, durationMs: 2300 },
    }));
    expect(msg?.content).toBe("npm test PASSED (2.3s)");
  });

  it("formats validation_step_completed fail", () => {
    const msg = formatRunEvent(makeEvent({
      type: "validation_step_completed",
      data: { step: "npm test", passed: false, error: "assertion failed" },
    }));
    expect(msg?.content).toContain("npm test FAILED");
    expect(msg?.content).toContain("assertion failed");
  });

  it("formats agent_retry", () => {
    const msg = formatRunEvent(makeEvent({
      type: "agent_retry",
      data: { attempt: 2, maxAttempts: 5 },
    }));
    expect(msg?.content).toBe("Retry attempt 2/5 -- feeding errors back to agent");
  });

  it("formats completed with embed", () => {
    const msg = formatRunEvent(makeEvent({
      type: "completed",
      data: { prUrl: "https://github.com/org/repo/pull/1", costUsd: 0.42, durationMs: 60000 },
    }));
    expect(msg?.embeds).toHaveLength(1);
    expect(msg!.embeds![0].title).toBe("Run Completed");
    expect(msg!.embeds![0].color).toBe(0x2ecc71);
    expect(msg!.embeds![0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "PR", value: "https://github.com/org/repo/pull/1" }),
      ]),
    );
  });

  it("formats failed with red embed", () => {
    const msg = formatRunEvent(makeEvent({
      type: "failed",
      data: { error: "container crashed" },
    }));
    expect(msg?.embeds).toHaveLength(1);
    expect(msg!.embeds![0].title).toBe("Run Failed");
    expect(msg!.embeds![0].color).toBe(0xe74c3c);
    expect(msg!.embeds![0].description).toContain("container crashed");
  });

  it("returns null for unhandled event types", () => {
    const msg = formatRunEvent(makeEvent({ type: "phase" }));
    expect(msg).toBeNull();
  });
});

describe("mergeMessages", () => {
  it("returns single message as-is", () => {
    const msg: DiscordMessage = { content: "hello" };
    expect(mergeMessages([msg])).toBe(msg);
  });

  it("merges multiple content messages", () => {
    const merged = mergeMessages([
      { content: "line 1" },
      { content: "line 2" },
    ]);
    expect(merged.content).toBe("line 1\nline 2");
  });

  it("merges embeds from multiple messages", () => {
    const merged = mergeMessages([
      { embeds: [{ title: "A", color: 0 }] },
      { embeds: [{ title: "B", color: 1 }] },
    ]);
    expect(merged.embeds).toHaveLength(2);
  });
});

describe("formatCostSummary", () => {
  it("produces embed with token, cost, duration fields", () => {
    const msg = formatCostSummary({
      totalTokens: 50000,
      costUsd: 1.23,
      durationMs: 120000,
      subIssues: [
        { identifier: "RAH-210", prUrl: "https://github.com/org/repo/pull/1", status: "success" },
        { identifier: "RAH-211", status: "failure" },
      ],
    });
    expect(msg.embeds).toHaveLength(1);
    const embed = msg.embeds![0];
    expect(embed.title).toBe("Run Summary");
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Total Tokens", value: "50,000" }),
        expect.objectContaining({ name: "Cost", value: "$1.23" }),
        expect.objectContaining({ name: "RAH-210" }),
        expect.objectContaining({ name: "RAH-211", value: "failure" }),
      ]),
    );
  });
});

describe("DiscordRunStream", () => {
  let poster: DiscordPoster;
  let posted: Array<{ threadId: string; message: DiscordMessage }>;

  beforeEach(() => {
    posted = [];
    poster = {
      postToThread: vi.fn(async (threadId, message) => {
        posted.push({ threadId, message });
      }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts formatted event to Discord thread", async () => {
    const stream = new DiscordRunStream({
      runId: "run-1",
      threadId: "thread-abc",
      poster,
      port: 3000,
    });
    stream.start();

    emitRunEvent({
      runId: "run-1",
      type: "agent_started",
      timestamp: new Date().toISOString(),
      data: {},
    });

    // Wait for flush (immediate since no prior send)
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    expect(posted[0].threadId).toBe("thread-abc");
    expect(posted[0].message.content).toBe("Agent started working...");

    stream.stop();
  });

  it("throttles rapid events into batched messages", async () => {
    vi.useFakeTimers();

    const stream = new DiscordRunStream({
      runId: "run-2",
      threadId: "thread-xyz",
      poster,
      port: 3000,
    });
    stream.start();

    // First event goes immediately
    emitRunEvent({
      runId: "run-2",
      type: "agent_started",
      timestamp: new Date().toISOString(),
      data: {},
    });

    expect(posted).toHaveLength(1);

    // Rapid subsequent events should be batched
    emitRunEvent({
      runId: "run-2",
      type: "validation_step_started",
      timestamp: new Date().toISOString(),
      data: { step: "npm test" },
    });

    emitRunEvent({
      runId: "run-2",
      type: "validation_step_completed",
      timestamp: new Date().toISOString(),
      data: { step: "npm test", passed: true, durationMs: 1200 },
    });

    // Not yet flushed
    expect(posted).toHaveLength(1);

    // Advance timer past throttle window
    vi.advanceTimersByTime(3000);

    expect(posted).toHaveLength(2);
    // Batched message should contain both events
    expect(posted[1].message.content).toContain("Running: npm test...");
    expect(posted[1].message.content).toContain("npm test PASSED");

    stream.stop();
    vi.useRealTimers();
  });

  it("prefixes sub-issue events with identifier", async () => {
    const stream = new DiscordRunStream({
      runId: "run-main",
      threadId: "thread-sub",
      poster,
      port: 3000,
      subIssues: [{ runId: "run-sub-1", identifier: "RAH-210" }],
    });
    stream.start();

    emitRunEvent({
      runId: "run-sub-1",
      type: "agent_started",
      timestamp: new Date().toISOString(),
      data: {},
    });

    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].message.content).toBe("[RAH-210] Agent started working...");

    stream.stop();
  });

  it("ignores events that produce null messages", async () => {
    vi.useFakeTimers();

    const stream = new DiscordRunStream({
      runId: "run-3",
      threadId: "thread-null",
      poster,
      port: 3000,
    });
    stream.start();

    emitRunEvent({
      runId: "run-3",
      type: "phase",
      timestamp: new Date().toISOString(),
      data: { phase: "validation" },
    });

    vi.advanceTimersByTime(5000);
    expect(posted).toHaveLength(0);

    stream.stop();
    vi.useRealTimers();
  });

  it("flushes pending messages on stop", () => {
    vi.useFakeTimers();

    const stream = new DiscordRunStream({
      runId: "run-4",
      threadId: "thread-stop",
      poster,
      port: 3000,
    });
    stream.start();

    // First event immediate
    emitRunEvent({
      runId: "run-4",
      type: "agent_started",
      timestamp: new Date().toISOString(),
      data: {},
    });

    // Queued event
    emitRunEvent({
      runId: "run-4",
      type: "agent_retry",
      timestamp: new Date().toISOString(),
      data: { attempt: 1, maxAttempts: 3 },
    });

    expect(posted).toHaveLength(1);

    stream.stop();

    // Should have flushed the pending event
    expect(posted).toHaveLength(2);

    vi.useRealTimers();
  });
});
