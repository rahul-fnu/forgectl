import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveRunPlan, type CLIOptions } from "../../src/workflow/resolver.js";
import { ConfigSchema } from "../../src/config/schema.js";

// Mock child_process to control git detection
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => { throw new Error("not a git repo"); }),
}));

// Mock fs.existsSync for language detection
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

import { existsSync } from "node:fs";
const mockExistsSync = vi.mocked(existsSync);

const defaultConfig = ConfigSchema.parse({});

function makeOptions(overrides: Partial<CLIOptions> = {}): CLIOptions {
  return {
    task: "Test task",
    ...overrides,
  };
}

describe("workflow resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("auto-detection", () => {
    it("detects code workflow when --repo is provided", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ repo: "/some/repo" }));
      expect(plan.workflow.name).toBe("code");
    });

    it("detects data workflow for .csv input", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ input: ["data.csv"] }));
      expect(plan.workflow.name).toBe("data");
    });

    it("detects data workflow for .tsv input", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ input: ["data.tsv"] }));
      expect(plan.workflow.name).toBe("data");
    });

    it("detects data workflow for .json input", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ input: ["data.json"] }));
      expect(plan.workflow.name).toBe("data");
    });

    it("detects content workflow for .md input", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ input: ["doc.md"] }));
      expect(plan.workflow.name).toBe("content");
    });

    it("detects content workflow for .txt input", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ input: ["doc.txt"] }));
      expect(plan.workflow.name).toBe("content");
    });

    it("falls back to general when not in git repo and no matching input", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions());
      expect(plan.workflow.name).toBe("general");
    });
  });

  describe("explicit workflow override", () => {
    it("uses explicit workflow when provided", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "research" }));
      expect(plan.workflow.name).toBe("research");
    });

    it("explicit workflow overrides auto-detection", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({
        workflow: "ops",
        input: ["data.csv"],
      }));
      expect(plan.workflow.name).toBe("ops");
    });
  });

  describe("merge priority", () => {
    it("CLI agent flag overrides config", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({
        workflow: "code",
        agent: "codex",
      }));
      expect(plan.agent.type).toBe("codex");
    });

    it("CLI model flag overrides config", () => {
      const configWithModel = ConfigSchema.parse({ agent: { model: "config-model" } });
      const plan = resolveRunPlan(configWithModel, makeOptions({
        workflow: "code",
        model: "cli-model",
      }));
      expect(plan.agent.model).toBe("cli-model");
    });

    it("config agent type is used when CLI does not specify", () => {
      const configWithCodex = ConfigSchema.parse({ agent: { type: "codex" } });
      const plan = resolveRunPlan(configWithCodex, makeOptions({ workflow: "code" }));
      expect(plan.agent.type).toBe("codex");
    });

    it("config image overrides workflow default", () => {
      const configWithImage = ConfigSchema.parse({ container: { image: "custom:latest" } });
      const plan = resolveRunPlan(configWithImage, makeOptions({ workflow: "code" }));
      expect(plan.container.image).toBe("custom:latest");
    });
  });

  describe("review flag", () => {
    it("--review enables review even if workflow default is false", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({
        workflow: "general", // general has review disabled
        review: true,
      }));
      expect(plan.orchestration.review.enabled).toBe(true);
    });

    it("--no-review disables review even if workflow default is true", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({
        workflow: "code", // code has review enabled
        review: false,    // commander sets review=false for --no-review
      }));
      expect(plan.orchestration.review.enabled).toBe(false);
    });

    it("uses workflow default when no review flag", () => {
      const codePlan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "code" }));
      expect(codePlan.orchestration.review.enabled).toBe(true);

      const generalPlan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "general" }));
      expect(generalPlan.orchestration.review.enabled).toBe(false);
    });
  });

  describe("network resolution", () => {
    it("open mode uses bridge network", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "code" }));
      expect(plan.container.network.mode).toBe("open");
      expect(plan.container.network.dockerNetwork).toBe("bridge");
    });

    it("airgapped mode uses none network", () => {
      const config = ConfigSchema.parse({ container: { network: { mode: "airgapped" } } });
      const plan = resolveRunPlan(config, makeOptions({ workflow: "code" }));
      expect(plan.container.network.mode).toBe("airgapped");
      expect(plan.container.network.dockerNetwork).toBe("none");
    });

    it("allowlist mode creates named network", () => {
      const config = ConfigSchema.parse({
        container: { network: { mode: "allowlist", allow: ["npmjs.org"] } }
      });
      const plan = resolveRunPlan(config, makeOptions({ workflow: "code" }));
      expect(plan.container.network.mode).toBe("allowlist");
      expect(plan.container.network.dockerNetwork).toMatch(/^forgectl-forge-/);
      expect(plan.container.network.allow).toContain("npmjs.org");
    });

    it("allowlist mode auto-adds api.anthropic.com for claude-code", () => {
      const config = ConfigSchema.parse({
        container: { network: { mode: "allowlist" } }
      });
      const plan = resolveRunPlan(config, makeOptions({ workflow: "code" }));
      expect(plan.container.network.allow).toContain("api.anthropic.com");
    });

    it("allowlist mode auto-adds api.openai.com for codex", () => {
      const config = ConfigSchema.parse({
        container: { network: { mode: "allowlist" } }
      });
      const plan = resolveRunPlan(config, makeOptions({ workflow: "code", agent: "codex" }));
      expect(plan.container.network.allow).toContain("api.openai.com");
    });
  });

  describe("RunPlan correctness", () => {
    it("code workflow has correct image and mount path", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "code" }));
      expect(plan.container.image).toBe("forgectl/code-node20");
      expect(plan.input.mountPath).toBe("/workspace");
      expect(plan.output.mode).toBe("git");
    });

    it("research workflow has correct output mode", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "research" }));
      expect(plan.container.image).toBe("forgectl/research-browser");
      expect(plan.input.mountPath).toBe("/input");
      expect(plan.output.mode).toBe("files");
      expect(plan.output.path).toBe("/output");
    });

    it("data workflow has correct setup", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "data" }));
      expect(plan.container.image).toBe("forgectl/data");
      expect(plan.input.mode).toBe("files");
      expect(plan.output.mode).toBe("files");
    });

    it("has correct run ID format", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "code" }));
      expect(plan.runId).toMatch(/^forge-\d+\.?-[a-f0-9]{4}$/);
    });

    it("resolves timeout from config", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "code" }));
      expect(plan.agent.timeout).toBe(1800000); // 30m default
    });

    it("CLI timeout overrides config", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({
        workflow: "code",
        timeout: "1h",
      }));
      expect(plan.agent.timeout).toBe(3600000);
    });
  });

  describe("team configuration", () => {
    it("team size propagated to RunPlan when workflow has team config", () => {
      const configWithTeam = ConfigSchema.parse({
        container: { resources: { memory: "4g" } },
      });
      const plan = resolveRunPlan(configWithTeam, makeOptions({ workflow: "code", teamSize: 3 }));
      expect(plan.team?.size).toBe(3);
      expect(plan.team?.slotWeight).toBe(3);
    });

    it("memory scaled correctly for team run (4g base + 2 teammates = 6g)", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "code", teamSize: 3 }));
      expect(plan.container.resources.memory).toBe("6g");
    });

    it("skipCheckpoints set to true for team runs", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "code", teamSize: 3 }));
      expect(plan.skipCheckpoints).toBe(true);
    });

    it("solo run (no team): no team fields, original memory", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "code" }));
      expect(plan.team).toBeUndefined();
      expect(plan.skipCheckpoints).toBeUndefined();
      expect(plan.container.resources.memory).toBe("4g");
    });

    it("--no-team (options.team=false): no team, original memory, noTeam=true", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({
        workflow: "code",
        teamSize: 3,
        team: false,
      }));
      expect(plan.noTeam).toBe(true);
      expect(plan.team).toBeUndefined();
      expect(plan.skipCheckpoints).toBeUndefined();
      expect(plan.container.resources.memory).toBe("4g");
    });

    it("--team-size override uses CLI value over workflow team size", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({
        workflow: "code",
        teamSize: 4,
      }));
      expect(plan.team?.size).toBe(4);
      // 4g base + 3 teammates = 7g
      expect(plan.container.resources.memory).toBe("7g");
    });

    it("memory scaling edge case: 4096m base correctly scales to 6g for 2 teammates", () => {
      const configWith4096m = ConfigSchema.parse({
        container: { resources: { memory: "4096m" } },
      });
      const plan = resolveRunPlan(configWith4096m, makeOptions({ workflow: "code", teamSize: 3 }));
      expect(plan.container.resources.memory).toBe("6g");
    });

    it("memory scaling: 2g base + 4 teammates (teamSize=5) = 6g", () => {
      const configWith2g = ConfigSchema.parse({
        container: { resources: { memory: "2g" } },
      });
      const plan = resolveRunPlan(configWith2g, makeOptions({ workflow: "code", teamSize: 5 }));
      // 2g + 4 teammates * 1GB = 6g
      expect(plan.container.resources.memory).toBe("6g");
    });
  });

  describe("language auto-detection", () => {
    beforeEach(() => {
      mockExistsSync.mockReset();
      mockExistsSync.mockReturnValue(false);
    });

    it("detects Python from pyproject.toml", () => {
      mockExistsSync.mockImplementation((p: any) =>
        String(p).endsWith("pyproject.toml")
      );
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "code" }));
      expect(plan.container.image).toBe("forgectl/code-python312");
    });

    it("detects Python from requirements.txt", () => {
      mockExistsSync.mockImplementation((p: any) =>
        String(p).endsWith("requirements.txt")
      );
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "code" }));
      expect(plan.container.image).toBe("forgectl/code-python312");
    });

    it("detects Go from go.mod", () => {
      mockExistsSync.mockImplementation((p: any) =>
        String(p).endsWith("go.mod")
      );
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "code" }));
      expect(plan.container.image).toBe("forgectl/code-go122");
    });

    it("detects Rust from Cargo.toml", () => {
      mockExistsSync.mockImplementation((p: any) =>
        String(p).endsWith("Cargo.toml")
      );
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "code" }));
      expect(plan.container.image).toBe("forgectl/code-rust");
    });

    it("falls back to Node image when no language marker found", () => {
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "code" }));
      expect(plan.container.image).toBe("forgectl/code-node20");
    });

    it("config image overrides language auto-detection", () => {
      mockExistsSync.mockImplementation((p: any) =>
        String(p).endsWith("pyproject.toml")
      );
      const configWithImage = ConfigSchema.parse({ container: { image: "custom:latest" } });
      const plan = resolveRunPlan(configWithImage, makeOptions({ workflow: "code" }));
      expect(plan.container.image).toBe("custom:latest");
    });

    it("sets Python validation defaults when Python detected", () => {
      mockExistsSync.mockImplementation((p: any) =>
        String(p).endsWith("pyproject.toml")
      );
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "code" }));
      const cmds = plan.validation.steps.map(s => s.command);
      expect(cmds).toContain("pytest");
      expect(cmds).toContain("ruff check .");
      expect(cmds).toContain("mypy .");
    });

    it("sets Go validation defaults when Go detected", () => {
      mockExistsSync.mockImplementation((p: any) =>
        String(p).endsWith("go.mod")
      );
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "code" }));
      const cmds = plan.validation.steps.map(s => s.command);
      expect(cmds).toContain("go test ./...");
      expect(cmds).toContain("golangci-lint run");
    });

    it("sets Rust validation defaults when Rust detected", () => {
      mockExistsSync.mockImplementation((p: any) =>
        String(p).endsWith("Cargo.toml")
      );
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "code" }));
      const cmds = plan.validation.steps.map(s => s.command);
      expect(cmds).toContain("cargo test");
      expect(cmds).toContain("cargo clippy -- -D warnings");
    });

    it("does not auto-detect for non-code workflows", () => {
      mockExistsSync.mockImplementation((p: any) =>
        String(p).endsWith("pyproject.toml")
      );
      const plan = resolveRunPlan(defaultConfig, makeOptions({ workflow: "research" }));
      expect(plan.container.image).toBe("forgectl/research-browser");
    });
  });
});
