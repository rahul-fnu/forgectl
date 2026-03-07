import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveToken } from "../../src/tracker/token.js";
import { TrackerConfigSchema } from "../../src/config/schema.js";
import { ConfigSchema } from "../../src/config/schema.js";

describe("resolveToken", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("resolves $VAR from process.env", () => {
    process.env.GITHUB_TOKEN = "ghp_abc123";
    expect(resolveToken("$GITHUB_TOKEN")).toBe("ghp_abc123");
  });

  it("returns literal token unchanged", () => {
    expect(resolveToken("literal-token-value")).toBe("literal-token-value");
  });

  it("throws when env var is not set", () => {
    delete process.env.MISSING_VAR;
    expect(() => resolveToken("$MISSING_VAR")).toThrow(
      'Tracker: environment variable "MISSING_VAR" is not set'
    );
  });

  it("throws when env var is empty string", () => {
    process.env.EMPTY_VAR = "";
    expect(() => resolveToken("$EMPTY_VAR")).toThrow(
      'Tracker: environment variable "EMPTY_VAR" is not set'
    );
  });
});

describe("TrackerConfigSchema", () => {
  it("parses valid github config", () => {
    const config = TrackerConfigSchema.parse({
      kind: "github",
      token: "$GITHUB_TOKEN",
      repo: "owner/repo",
    });
    expect(config.kind).toBe("github");
    expect(config.repo).toBe("owner/repo");
    expect(config.active_states).toEqual(["open"]);
    expect(config.terminal_states).toEqual(["closed"]);
    expect(config.poll_interval_ms).toBe(60000);
    expect(config.auto_close).toBe(false);
  });

  it("parses valid notion config", () => {
    const config = TrackerConfigSchema.parse({
      kind: "notion",
      token: "$NOTION_TOKEN",
      database_id: "abc-123",
    });
    expect(config.kind).toBe("notion");
    expect(config.database_id).toBe("abc-123");
  });

  it("rejects github config without repo", () => {
    const result = TrackerConfigSchema.safeParse({
      kind: "github",
      token: "tok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects notion config without database_id", () => {
    const result = TrackerConfigSchema.safeParse({
      kind: "notion",
      token: "tok",
    });
    expect(result.success).toBe(false);
  });

  it("applies default values", () => {
    const config = TrackerConfigSchema.parse({
      kind: "github",
      token: "tok",
      repo: "o/r",
    });
    expect(config.active_states).toEqual(["open"]);
    expect(config.terminal_states).toEqual(["closed"]);
    expect(config.poll_interval_ms).toBe(60000);
    expect(config.auto_close).toBe(false);
    expect(config.in_progress_label).toBeUndefined();
    expect(config.done_label).toBeUndefined();
  });

  it("accepts optional label config", () => {
    const config = TrackerConfigSchema.parse({
      kind: "github",
      token: "tok",
      repo: "o/r",
      in_progress_label: "in-progress",
      done_label: "done",
    });
    expect(config.in_progress_label).toBe("in-progress");
    expect(config.done_label).toBe("done");
  });
});

describe("ConfigSchema with tracker", () => {
  it("still parses empty object (no tracker)", () => {
    const config = ConfigSchema.parse({});
    expect(config.tracker).toBeUndefined();
  });

  it("parses config with tracker section", () => {
    const config = ConfigSchema.parse({
      tracker: {
        kind: "github",
        token: "$GH_TOKEN",
        repo: "owner/repo",
      },
    });
    expect(config.tracker).toBeDefined();
    expect(config.tracker!.kind).toBe("github");
  });
});
