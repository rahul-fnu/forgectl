import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractRepo, truncateTitle, dispatchTask, DiscordBot, type DiscordBotDeps } from "../../src/discord/bot.js";
import { ConfigSchema } from "../../src/config/schema.js";
import type { Logger } from "../../src/logging/logger.js";

describe("extractRepo", () => {
  it("extracts repo from GitHub URL", () => {
    expect(extractRepo("Fix bug in https://github.com/owner/repo please")).toBe("owner/repo");
  });

  it("extracts repo from repo: pattern", () => {
    expect(extractRepo("repo: owner/my-repo do stuff")).toBe("owner/my-repo");
  });

  it("returns undefined when no repo found", () => {
    expect(extractRepo("just a plain task")).toBeUndefined();
  });

  it("handles URL with trailing path segments", () => {
    expect(extractRepo("see https://github.com/org/proj/issues/42")).toBe("org/proj");
  });
});

describe("truncateTitle", () => {
  it("returns short text as-is", () => {
    expect(truncateTitle("short")).toBe("short");
  });

  it("truncates long text with ellipsis", () => {
    const long = "a".repeat(60);
    const result = truncateTitle(long);
    expect(result.length).toBe(51); // 50 chars + ellipsis
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns exactly 50 chars unchanged", () => {
    const exact = "a".repeat(50);
    expect(truncateTitle(exact)).toBe(exact);
  });
});

describe("dispatchTask", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends POST to dispatch endpoint with correct body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "run-123", status: "dispatched" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await dispatchTask("fix the bug", "owner/repo", 4856, "tok123");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:4856/api/v1/dispatch");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok123");
    const body = JSON.parse(opts.body);
    expect(body.description).toBe("fix the bug");
    expect(body.repo).toBe("owner/repo");
    expect(result.status).toBe("dispatched");
    expect(result.id).toBe("run-123");
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    }));

    await expect(dispatchTask("task", undefined, 4856, "tok")).rejects.toThrow("Dispatch failed (503)");
  });
});

describe("DiscordBot", () => {
  function makeMockLogger(): Logger {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      verbose: false,
    } as unknown as Logger;
  }

  function makeDeps(overrides?: Partial<DiscordBotDeps>): DiscordBotDeps {
    return {
      config: ConfigSchema.parse({ discord: { enabled: true, bot_token: "fake-token", guild_id: "guild-1" } }),
      logger: makeMockLogger(),
      daemonPort: 4856,
      daemonToken: "daemon-tok",
      ...overrides,
    };
  }

  it("constructs without error", () => {
    const bot = new DiscordBot(makeDeps());
    expect(bot).toBeDefined();
    expect(bot.getThreadMap()).toBeInstanceOf(Map);
  });

  it("ignores bot messages in handleMessage", async () => {
    const bot = new DiscordBot(makeDeps());
    const msg = {
      author: { bot: true },
      channelId: "ch1",
      content: "hello",
    } as any;

    // Should return early without throwing
    await bot.handleMessage(msg);
  });

  it("ignores messages from non-configured channels", async () => {
    const deps = makeDeps({
      config: ConfigSchema.parse({
        discord: { enabled: true, bot_token: "t", guild_id: "g", channel_ids: ["ch-allowed"] },
      }),
    });
    const bot = new DiscordBot(deps);

    const msg = {
      author: { bot: false },
      channelId: "ch-other",
      content: "hello",
      startThread: vi.fn(),
    } as any;

    await bot.handleMessage(msg);
    expect(msg.startThread).not.toHaveBeenCalled();
  });

  it("creates thread and dispatches on valid message", async () => {
    const bot = new DiscordBot(makeDeps());

    const mockThread = {
      id: "thread-1",
      send: vi.fn(),
    };
    const msg = {
      author: { bot: false },
      channelId: "ch1",
      content: "Fix the login bug in https://github.com/acme/app",
      startThread: vi.fn().mockResolvedValue(mockThread),
      reply: vi.fn(),
    } as any;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "run-abc", status: "dispatched" }),
    }));

    await bot.handleMessage(msg);

    expect(msg.startThread).toHaveBeenCalledWith({
      name: "Working on: Fix the login bug in https://github.com/acme/app",
    });
    expect(mockThread.send).toHaveBeenCalledWith('Task dispatched! Run ID: `run-abc`');
    expect(bot.getThreadMap().get("thread-1")).toBe("run-abc");
  });

  it("handles decomposed response", async () => {
    const bot = new DiscordBot(makeDeps());

    const mockThread = { id: "thread-2", send: vi.fn() };
    const msg = {
      author: { bot: false },
      channelId: "ch1",
      content: "Build the entire feature",
      startThread: vi.fn().mockResolvedValue(mockThread),
      reply: vi.fn(),
    } as any;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "decomposed",
        parentIssueId: "parent-1",
        childIssues: ["child-1", "child-2"],
      }),
    }));

    await bot.handleMessage(msg);

    expect(mockThread.send).toHaveBeenCalledWith(
      expect.stringContaining("sub-issues"),
    );
    expect(mockThread.send).toHaveBeenCalledWith(
      expect.stringContaining("child-1"),
    );
    expect(bot.getThreadMap().get("thread-2")).toBe("parent-1");
  });

  it("listens on all channels when channel_ids is empty", async () => {
    const deps = makeDeps({
      config: ConfigSchema.parse({
        discord: { enabled: true, bot_token: "t", guild_id: "g", channel_ids: [] },
      }),
    });
    const bot = new DiscordBot(deps);

    const mockThread = { id: "t3", send: vi.fn() };
    const msg = {
      author: { bot: false },
      channelId: "any-random-channel",
      content: "do something",
      startThread: vi.fn().mockResolvedValue(mockThread),
    } as any;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "run-x", status: "dispatched" }),
    }));

    await bot.handleMessage(msg);
    expect(msg.startThread).toHaveBeenCalled();
  });
});

describe("ConfigSchema discord section", () => {
  it("parses with discord defaults", () => {
    const config = ConfigSchema.parse({});
    expect(config.discord).toBeUndefined();
  });

  it("parses with discord enabled", () => {
    const config = ConfigSchema.parse({
      discord: { enabled: true, bot_token: "abc", guild_id: "g1", channel_ids: ["c1", "c2"] },
    });
    expect(config.discord.enabled).toBe(true);
    expect(config.discord.bot_token).toBe("abc");
    expect(config.discord.channel_ids).toEqual(["c1", "c2"]);
  });
});
