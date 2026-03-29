import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectClarificationNeed,
  extractQuestion,
  requestClarificationViaDiscord,
  resolveButtonAction,
  buildClarificationButtons,
  buildReviewButtons,
  buildFailedRunButtons,
  createDiscordClarificationCallback,
  BUTTON_IDS,
  CLARIFICATION_PATTERNS,
  DEFAULT_CLARIFICATION_TIMEOUT_MS,
  type DiscordClient,
  type DiscordReply,
} from "../../src/discord/clarify.js";

describe("detectClarificationNeed", () => {
  it("detects 'I need clarification' pattern", () => {
    const output = "Analyzing the code...\nI need clarification on the database schema.\nContinuing...";
    expect(detectClarificationNeed(output)).toBe(
      "I need clarification on the database schema.",
    );
  });

  it("detects 'Which approach' pattern", () => {
    const output = "Which approach should I take for the API design?";
    expect(detectClarificationNeed(output)).toBe(
      "Which approach should I take for the API design?",
    );
  });

  it("detects 'Should I' pattern", () => {
    const output = "Should I use PostgreSQL or MySQL for this project?";
    expect(detectClarificationNeed(output)).toBe(
      "Should I use PostgreSQL or MySQL for this project?",
    );
  });

  it("detects 'unclear whether' pattern", () => {
    const output = "It is unclear whether the API should be REST or GraphQL.";
    expect(detectClarificationNeed(output)).toBe(
      "It is unclear whether the API should be REST or GraphQL.",
    );
  });

  it("returns undefined when no clarification needed", () => {
    const output = "Successfully built the project.\nAll tests pass.\nDone.";
    expect(detectClarificationNeed(output)).toBeUndefined();
  });

  it("returns undefined for empty output", () => {
    expect(detectClarificationNeed("")).toBeUndefined();
  });

  it("is case-insensitive", () => {
    const output = "SHOULD I refactor this module?";
    expect(detectClarificationNeed(output)).toBe(
      "SHOULD I refactor this module?",
    );
  });
});

describe("extractQuestion", () => {
  it("extracts matched line with surrounding context", () => {
    const output = "Line 1\nLine 2\nI need clarification on X.\nLine 4\nLine 5";
    const result = extractQuestion(output, "I need clarification on X.");
    expect(result).toContain("I need clarification on X.");
    expect(result).toContain("Line 2");
    expect(result).toContain("Line 4");
  });

  it("returns matched line if not found in output", () => {
    const output = "something else";
    const result = extractQuestion(output, "missing line");
    expect(result).toBe("missing line");
  });

  it("handles match at start of output", () => {
    const output = "Should I do X?\nNext line";
    const result = extractQuestion(output, "Should I do X?");
    expect(result).toContain("Should I do X?");
    expect(result).toContain("Next line");
  });
});

describe("requestClarificationViaDiscord", () => {
  let client: DiscordClient;

  beforeEach(() => {
    client = {
      sendMessageToThread: vi.fn().mockResolvedValue("msg-1"),
      waitForReply: vi.fn().mockResolvedValue(null),
    };
  });

  it("posts question to Discord thread with mention", async () => {
    await requestClarificationViaDiscord(
      client,
      "thread-123",
      "Which database?",
      "user-456",
    );

    expect(client.sendMessageToThread).toHaveBeenCalledWith(
      "thread-123",
      expect.stringContaining("<@user-456>"),
      expect.objectContaining({
        mentionUserId: "user-456",
        components: [buildClarificationButtons()],
      }),
    );
    expect(
      (client.sendMessageToThread as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).toContain("Which database?");
  });

  it("returns timedOut when no reply received", async () => {
    (client.waitForReply as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await requestClarificationViaDiscord(
      client,
      "thread-123",
      "Which database?",
    );

    expect(result).toEqual({
      answered: false,
      skipped: false,
      timedOut: true,
    });
    // Should post timeout message
    expect(client.sendMessageToThread).toHaveBeenCalledTimes(2);
    expect(
      (client.sendMessageToThread as ReturnType<typeof vi.fn>).mock.calls[1][1],
    ).toContain("No response received");
  });

  it("returns answer when user replies with text", async () => {
    const reply: DiscordReply = {
      content: "Use PostgreSQL",
      userId: "user-456",
      isButtonInteraction: false,
    };
    (client.waitForReply as ReturnType<typeof vi.fn>).mockResolvedValue(reply);

    const result = await requestClarificationViaDiscord(
      client,
      "thread-123",
      "Which database?",
    );

    expect(result).toEqual({
      answered: true,
      answer: "Use PostgreSQL",
      skipped: false,
      timedOut: false,
    });
  });

  it("returns skipped when Skip button is pressed", async () => {
    const reply: DiscordReply = {
      content: "",
      userId: "user-456",
      isButtonInteraction: true,
      buttonCustomId: BUTTON_IDS.SKIP,
    };
    (client.waitForReply as ReturnType<typeof vi.fn>).mockResolvedValue(reply);

    const result = await requestClarificationViaDiscord(
      client,
      "thread-123",
      "Which database?",
    );

    expect(result).toEqual({
      answered: false,
      skipped: true,
      timedOut: false,
    });
  });

  it("uses default 30-min timeout", async () => {
    await requestClarificationViaDiscord(
      client,
      "thread-123",
      "question",
    );

    expect(client.waitForReply).toHaveBeenCalledWith(
      "thread-123",
      DEFAULT_CLARIFICATION_TIMEOUT_MS,
    );
  });

  it("uses custom timeout when provided", async () => {
    await requestClarificationViaDiscord(
      client,
      "thread-123",
      "question",
      undefined,
      5000,
    );

    expect(client.waitForReply).toHaveBeenCalledWith("thread-123", 5000);
  });
});

describe("createDiscordClarificationCallback", () => {
  it("creates a callback that routes through Discord", async () => {
    const reply: DiscordReply = {
      content: "PostgreSQL",
      userId: "user-1",
      isButtonInteraction: false,
    };
    const client: DiscordClient = {
      sendMessageToThread: vi.fn().mockResolvedValue("msg-1"),
      waitForReply: vi.fn().mockResolvedValue(reply),
    };

    const callback = createDiscordClarificationCallback(
      client,
      "thread-1",
      "user-1",
    );
    const answer = await callback("Which database?");

    expect(answer).toBe("PostgreSQL");
    expect(client.sendMessageToThread).toHaveBeenCalled();
  });

  it("returns undefined on timeout", async () => {
    const client: DiscordClient = {
      sendMessageToThread: vi.fn().mockResolvedValue("msg-1"),
      waitForReply: vi.fn().mockResolvedValue(null),
    };

    const callback = createDiscordClarificationCallback(
      client,
      "thread-1",
    );
    const answer = await callback("Which database?");

    expect(answer).toBeUndefined();
  });
});

describe("resolveButtonAction", () => {
  it("resolves approve button", () => {
    expect(resolveButtonAction(BUTTON_IDS.APPROVE)).toEqual({
      action: "approve",
    });
  });

  it("resolves reject button", () => {
    expect(resolveButtonAction(BUTTON_IDS.REJECT)).toEqual({
      action: "reject",
    });
  });

  it("resolves retry button", () => {
    expect(resolveButtonAction(BUTTON_IDS.RETRY)).toEqual({
      action: "retry",
    });
  });

  it("resolves skip button", () => {
    expect(resolveButtonAction(BUTTON_IDS.SKIP)).toEqual({
      action: "skip",
    });
  });

  it("returns undefined for unknown button", () => {
    expect(resolveButtonAction("unknown")).toBeUndefined();
  });
});

describe("button builders", () => {
  it("buildClarificationButtons includes Skip", () => {
    const row = buildClarificationButtons();
    expect(row.buttons).toHaveLength(1);
    expect(row.buttons[0].customId).toBe(BUTTON_IDS.SKIP);
  });

  it("buildReviewButtons includes Approve and Reject", () => {
    const row = buildReviewButtons();
    expect(row.buttons).toHaveLength(2);
    expect(row.buttons.map((b) => b.customId)).toContain(BUTTON_IDS.APPROVE);
    expect(row.buttons.map((b) => b.customId)).toContain(BUTTON_IDS.REJECT);
  });

  it("buildFailedRunButtons includes Retry", () => {
    const row = buildFailedRunButtons();
    expect(row.buttons).toHaveLength(1);
    expect(row.buttons[0].customId).toBe(BUTTON_IDS.RETRY);
  });
});

describe("CLARIFICATION_PATTERNS", () => {
  it("has at least 4 patterns", () => {
    expect(CLARIFICATION_PATTERNS.length).toBeGreaterThanOrEqual(4);
  });

  it("all patterns are RegExp instances", () => {
    for (const p of CLARIFICATION_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });
});
