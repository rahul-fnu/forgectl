import { describe, it, expect } from "vitest";
import {
  buildTaskSubmittedEmbed,
  buildCompletedEmbed,
  buildFailedEmbed,
  buildProgressEmbed,
  buildClarificationEmbed,
  buildStatsEmbed,
  buildReactionControlsHelp,
} from "../../src/discord/embeds.js";
import type { RunEvent } from "../../src/logging/events.js";
import { StreamSubscriber } from "../../src/discord/stream-subscriber.js";
import { REACTION_CONTROLS } from "../../src/discord/types.js";

describe("discord embeds", () => {
  describe("buildTaskSubmittedEmbed", () => {
    it("includes run ID and task description", () => {
      const embed = buildTaskSubmittedEmbed("run-abc", "Fix the auth bug");
      expect(embed.title).toBe("Task Dispatched");
      expect(embed.description).toBe("Fix the auth bug");
      expect(embed.fields).toBeDefined();
      expect(embed.fields![0].value).toContain("run-abc");
    });

    it("truncates long task descriptions", () => {
      const longTask = "x".repeat(5000);
      const embed = buildTaskSubmittedEmbed("run-1", longTask);
      expect(embed.description!.length).toBeLessThanOrEqual(4003);
      expect(embed.description!.endsWith("...")).toBe(true);
    });
  });

  describe("buildCompletedEmbed", () => {
    it("shows completed status with green color", () => {
      const embed = buildCompletedEmbed("run-123", { filesChanged: 5 });
      expect(embed.title).toBe("Run Completed");
      expect(embed.color).toBe(0x2eb886);
      const filesField = embed.fields!.find((f) => f.name === "Files Changed");
      expect(filesField?.value).toBe("5");
    });

    it("includes PR URL when present", () => {
      const embed = buildCompletedEmbed("run-123", {
        prUrl: "https://github.com/org/repo/pull/42",
      });
      const prField = embed.fields!.find((f) => f.name === "Pull Request");
      expect(prField?.value).toBe("https://github.com/org/repo/pull/42");
    });

    it("includes cost and branch when present", () => {
      const embed = buildCompletedEmbed("run-123", {
        costUsd: 0.0512,
        branch: "forge/my-feature/abc123",
      });
      const costField = embed.fields!.find((f) => f.name === "Cost");
      expect(costField?.value).toBe("$0.0512");
      const branchField = embed.fields!.find((f) => f.name === "Branch");
      expect(branchField?.value).toContain("forge/my-feature/abc123");
    });
  });

  describe("buildFailedEmbed", () => {
    it("shows failed status with red color", () => {
      const embed = buildFailedEmbed("run-456", { error: "Container crashed" });
      expect(embed.title).toBe("Run Failed");
      expect(embed.color).toBe(0xa30200);
      const errorField = embed.fields!.find((f) => f.name === "Error");
      expect(errorField?.value).toBe("Container crashed");
    });

    it("truncates long error messages", () => {
      const embed = buildFailedEmbed("run-456", { error: "e".repeat(2000) });
      const errorField = embed.fields!.find((f) => f.name === "Error");
      expect(errorField?.value.length).toBeLessThanOrEqual(1024);
    });
  });

  describe("buildProgressEmbed", () => {
    it("formats phase events", () => {
      const event: RunEvent = {
        runId: "run-1",
        type: "phase",
        timestamp: new Date().toISOString(),
        data: { phase: "validation" },
      };
      const embed = buildProgressEmbed("run-1", event);
      expect(embed.description).toContain("validation");
    });

    it("formats validation_step_completed events", () => {
      const event: RunEvent = {
        runId: "run-1",
        type: "validation_step_completed",
        timestamp: new Date().toISOString(),
        data: { name: "lint", passed: true },
      };
      const embed = buildProgressEmbed("run-1", event);
      expect(embed.description).toContain("passed");
      expect(embed.description).toContain("lint");
    });

    it("shows failure for failed validation step", () => {
      const event: RunEvent = {
        runId: "run-1",
        type: "validation_step_completed",
        timestamp: new Date().toISOString(),
        data: { name: "typecheck", passed: false },
      };
      const embed = buildProgressEmbed("run-1", event);
      expect(embed.description).toContain("failed");
    });

    it("formats agent_started events", () => {
      const event: RunEvent = {
        runId: "run-1",
        type: "agent_started",
        timestamp: new Date().toISOString(),
        data: {},
      };
      const embed = buildProgressEmbed("run-1", event);
      expect(embed.description).toContain("Agent started");
    });

    it("formats retry events", () => {
      const event: RunEvent = {
        runId: "run-1",
        type: "retry",
        timestamp: new Date().toISOString(),
        data: { attempt: 2 },
      };
      const embed = buildProgressEmbed("run-1", event);
      expect(embed.description).toContain("Retrying");
      expect(embed.description).toContain("2");
    });

    it("formats cost events", () => {
      const event: RunEvent = {
        runId: "run-1",
        type: "cost",
        timestamp: new Date().toISOString(),
        data: { costUsd: 0.123 },
      };
      const embed = buildProgressEmbed("run-1", event);
      expect(embed.description).toContain("$0.1230");
    });
  });

  describe("buildClarificationEmbed", () => {
    it("includes question and warning color", () => {
      const embed = buildClarificationEmbed("run-789", "Which database should I use?");
      expect(embed.title).toBe("Clarification Needed");
      expect(embed.description).toBe("Which database should I use?");
      expect(embed.color).toBe(0xdaa038);
      expect(embed.footer?.text).toContain("Reply in this thread");
    });

    it("truncates long questions", () => {
      const longQuestion = "q".repeat(5000);
      const embed = buildClarificationEmbed("run-789", longQuestion);
      expect(embed.description!.length).toBeLessThanOrEqual(4003);
    });
  });

  describe("buildStatsEmbed", () => {
    it("renders analytics summary fields", () => {
      const embed = buildStatsEmbed({
        totalRuns: 42,
        successRate: 0.857,
        totalCost: 12.34,
        avgDuration: "5m 23s",
      });
      expect(embed.title).toBe("Analytics Summary");
      const totalField = embed.fields!.find((f) => f.name === "Total Runs");
      expect(totalField?.value).toBe("42");
      const rateField = embed.fields!.find((f) => f.name === "Success Rate");
      expect(rateField?.value).toBe("85.7%");
      const costField = embed.fields!.find((f) => f.name === "Total Cost");
      expect(costField?.value).toBe("$12.34");
    });

    it("handles missing fields gracefully", () => {
      const embed = buildStatsEmbed({});
      expect(embed.fields).toEqual([]);
    });
  });

  describe("buildReactionControlsHelp", () => {
    it("includes all reaction controls", () => {
      const embed = buildReactionControlsHelp();
      expect(embed.title).toBe("Reaction Controls");
      expect(embed.fields).toBeDefined();
      expect(embed.fields!.length).toBe(6);

      const fieldNames = embed.fields!.map((f) => f.name);
      expect(fieldNames.some((n) => n.includes("Cancel"))).toBe(true);
      expect(fieldNames.some((n) => n.includes("Retry"))).toBe(true);
      expect(fieldNames.some((n) => n.includes("Approve"))).toBe(true);
      expect(fieldNames.some((n) => n.includes("Reject"))).toBe(true);
      expect(fieldNames.some((n) => n.includes("Pause"))).toBe(true);
      expect(fieldNames.some((n) => n.includes("Logs"))).toBe(true);
    });

    it("uses correct color", () => {
      const embed = buildReactionControlsHelp();
      expect(embed.color).toBe(0x5865f2);
    });
  });
});

describe("StreamSubscriber", () => {
  it("can be instantiated and stopped without error", () => {
    const sub = new StreamSubscriber();
    sub.stop();
  });
});

describe("REACTION_CONTROLS", () => {
  it("has all expected control emojis", () => {
    expect(REACTION_CONTROLS.CANCEL).toBeDefined();
    expect(REACTION_CONTROLS.RETRY).toBeDefined();
    expect(REACTION_CONTROLS.APPROVE).toBeDefined();
    expect(REACTION_CONTROLS.REJECT).toBeDefined();
    expect(REACTION_CONTROLS.PAUSE).toBeDefined();
    expect(REACTION_CONTROLS.LOGS).toBeDefined();
  });
});

describe("discord config schema", () => {
  it("discord config has defaults when not provided", async () => {
    const { ConfigSchema } = await import("../../src/config/schema.js");
    const result = ConfigSchema.parse({});
    expect(result.discord).toBeDefined();
    expect(result.discord.enabled).toBe(false);
    expect(result.discord.channel_repos).toEqual([]);
    expect(result.discord.reaction_controls).toBe(true);
  });

  it("validates discord config when present", async () => {
    const { ConfigSchema } = await import("../../src/config/schema.js");
    const result = ConfigSchema.parse({
      discord: {
        token: "test-token-123",
        daemon_url: "http://localhost:4856",
        allowed_channel_ids: ["123456789"],
        notification_channel_id: "987654321",
      },
    });
    expect(result.discord).toBeDefined();
    expect(result.discord!.token).toBe("test-token-123");
    expect(result.discord!.daemon_url).toBe("http://localhost:4856");
    expect(result.discord!.allowed_channel_ids).toEqual(["123456789"]);
  });

  it("validates channel_repos config", async () => {
    const { ConfigSchema } = await import("../../src/config/schema.js");
    const result = ConfigSchema.parse({
      discord: {
        channel_repos: [
          { channel_id: "123", repo: "org/repo", workflow: "code-node" },
        ],
      },
    });
    expect(result.discord!.channel_repos).toHaveLength(1);
    expect(result.discord!.channel_repos[0].repo).toBe("org/repo");
    expect(result.discord!.channel_repos[0].workflow).toBe("code-node");
  });
});
