import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTrackerAdapter } from "../../src/tracker/registry.js";
import { TrackerConfigSchema } from "../../src/config/schema.js";
import type { TrackerConfig } from "../../src/tracker/types.js";

// Mock fetch globally so adapter constructors don't make real HTTP calls
const fetchMock = vi.fn().mockResolvedValue(
  new Response(JSON.stringify([]), { status: 200 }),
);

beforeAll(() => {
  process.env.TEST_GH_TOKEN = "ghp_test123";
  process.env.TEST_NOTION_TOKEN = "ntn_test456";
  vi.stubGlobal("fetch", fetchMock);
});

afterAll(() => {
  delete process.env.TEST_GH_TOKEN;
  delete process.env.TEST_NOTION_TOKEN;
  vi.restoreAllMocks();
});

describe("tracker registry integration", () => {
  it("creates a github adapter from valid config", () => {
    const config: TrackerConfig = {
      kind: "github",
      token: "$TEST_GH_TOKEN",
      repo: "owner/repo",
      active_states: ["open"],
      terminal_states: ["closed"],
      poll_interval_ms: 60000,
      auto_close: false,
    };

    const adapter = createTrackerAdapter(config);
    expect(adapter.kind).toBe("github");
    expect(typeof adapter.fetchCandidateIssues).toBe("function");
  });

  it("creates a notion adapter from valid config", () => {
    const config: TrackerConfig = {
      kind: "notion",
      token: "$TEST_NOTION_TOKEN",
      database_id: "abc-123-def-456",
      active_states: ["In Progress"],
      terminal_states: ["Done"],
      poll_interval_ms: 60000,
      auto_close: false,
    };

    const adapter = createTrackerAdapter(config);
    expect(adapter.kind).toBe("notion");
    expect(typeof adapter.fetchCandidateIssues).toBe("function");
  });

  it("creates a linear adapter from valid config", () => {
    const config: TrackerConfig = {
      kind: "linear",
      token: "lin_api_test",
      team_ids: ["team-uuid-1"],
      active_states: ["In Progress"],
      terminal_states: ["Done"],
      poll_interval_ms: 60000,
      auto_close: false,
    };

    const adapter = createTrackerAdapter(config);
    expect(adapter.kind).toBe("linear");
    expect(typeof adapter.fetchCandidateIssues).toBe("function");
  });

  it("throws on unknown tracker kind with available kinds listed", () => {
    const config = {
      kind: "jira" as "github",
      token: "some-token",
      active_states: ["open"],
      terminal_states: ["closed"],
      poll_interval_ms: 60000,
      auto_close: false,
    } as TrackerConfig;

    expect(() => createTrackerAdapter(config)).toThrow(/unknown kind/i);
    expect(() => createTrackerAdapter(config)).toThrow("github");
    expect(() => createTrackerAdapter(config)).toThrow("linear");
  });

  it("full flow: parse raw config through schema then create adapter", () => {
    const rawConfig = {
      kind: "github",
      token: "$TEST_GH_TOKEN",
      repo: "myorg/myrepo",
    };

    const parsed = TrackerConfigSchema.parse(rawConfig);
    const adapter = createTrackerAdapter(parsed);
    expect(adapter.kind).toBe("github");
  });

  it("config validation catches missing required fields before adapter creation", () => {
    const rawConfig = {
      kind: "github",
      token: "$TEST_GH_TOKEN",
      // Missing repo — should fail superRefine
    };

    const result = TrackerConfigSchema.safeParse(rawConfig);
    expect(result.success).toBe(false);
    if (!result.success) {
      const repoIssue = result.error.issues.find((i) =>
        i.path.includes("repo"),
      );
      expect(repoIssue).toBeDefined();
    }
  });
});
