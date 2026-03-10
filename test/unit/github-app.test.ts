import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../src/config/schema.js";
import type { RunRow } from "../../src/storage/repositories/runs.js";

describe("GitHubAppConfigSchema", () => {
  it("validates valid config with required fields", () => {
    const config = ConfigSchema.parse({
      github_app: {
        app_id: 12345,
        private_key_path: "/path/to/key.pem",
        webhook_secret: "secret",
      },
    });

    expect(config.github_app).toBeDefined();
    expect(config.github_app!.app_id).toBe(12345);
    expect(config.github_app!.private_key_path).toBe("/path/to/key.pem");
    expect(config.github_app!.webhook_secret).toBe("secret");
  });

  it("rejects missing app_id", () => {
    expect(() =>
      ConfigSchema.parse({
        github_app: {
          private_key_path: "/path/to/key.pem",
          webhook_secret: "secret",
        },
      })
    ).toThrow();
  });

  it("allows optional installation_id", () => {
    const config = ConfigSchema.parse({
      github_app: {
        app_id: 12345,
        private_key_path: "/path/to/key.pem",
        webhook_secret: "secret",
        installation_id: 67890,
      },
    });

    expect(config.github_app!.installation_id).toBe(67890);
  });

  it("accepts github_app as optional section (undefined = no GitHub App)", () => {
    const config = ConfigSchema.parse({});
    expect(config.github_app).toBeUndefined();
  });
});

describe("RunRow githubCommentId", () => {
  it("RunRow includes githubCommentId field (nullable)", () => {
    // Compile-time type check: RunRow must have githubCommentId
    const row: RunRow = {
      id: "run-1",
      task: "test",
      workflow: null,
      status: "queued",
      options: null,
      submittedAt: "2026-01-01T00:00:00Z",
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      pauseReason: null,
      pauseContext: null,
      approvalContext: null,
      approvalAction: null,
      githubCommentId: null,
    };
    expect(row.githubCommentId).toBeNull();

    const rowWithId: RunRow = { ...row, githubCommentId: 42 };
    expect(rowWithId.githubCommentId).toBe(42);
  });
});
