import { describe, it, expect } from "vitest";
import { deriveWorkspaceHooks } from "../../src/daemon/server.js";
import { ConfigSchema, type ForgectlConfig } from "../../src/config/schema.js";

function makeConfig(overrides: Record<string, unknown> = {}): ForgectlConfig {
  return ConfigSchema.parse(overrides);
}

describe("deriveWorkspaceHooks", () => {
  it("auto-generates after_create when tracker.repo is set and no hook exists", () => {
    const config = makeConfig({
      tracker: { kind: "github", repo: "owner/repo", token: "$GH_TOKEN" },
    });

    const result = deriveWorkspaceHooks(config);
    expect(result.workspace?.hooks?.after_create).toContain("git clone https://github.com/owner/repo.git .");
    expect(result.workspace?.hooks?.after_create).toContain("git config user.name forgectl");
  });

  it("does not override explicit after_create hook", () => {
    const config = makeConfig({
      tracker: { kind: "github", repo: "owner/repo", token: "$GH_TOKEN" },
      workspace: {
        root: "~/.forgectl/workspaces",
        hooks: { after_create: "custom-hook.sh" },
        hook_timeout: "60s",
      },
    });

    const result = deriveWorkspaceHooks(config);
    expect(result.workspace?.hooks?.after_create).toBe("custom-hook.sh");
  });

  it("returns config unchanged for non-github trackers", () => {
    const config = makeConfig({
      tracker: { kind: "notion", database_id: "abc", token: "secret" },
    });

    const result = deriveWorkspaceHooks(config);
    expect(result).toBe(config); // Same reference — no mutation
  });

  it("returns config unchanged when no tracker", () => {
    const config = makeConfig({});
    const result = deriveWorkspaceHooks(config);
    expect(result).toBe(config);
  });

  it("preserves existing workspace settings when adding hook", () => {
    const config = makeConfig({
      tracker: { kind: "github", repo: "owner/repo", token: "$GH_TOKEN" },
      workspace: {
        root: "/custom/root",
        hooks: { before_run: "echo before" },
        hook_timeout: "120s",
      },
    });

    const result = deriveWorkspaceHooks(config);
    expect(result.workspace?.root).toBe("/custom/root");
    expect(result.workspace?.hooks?.before_run).toBe("echo before");
    expect(result.workspace?.hooks?.after_create).toContain("git clone");
    expect(result.workspace?.hook_timeout).toBe("120s");
  });
});
