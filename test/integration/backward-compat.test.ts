import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config/schema.js";
import { getWorkflow } from "../../src/workflow/resolver.js";
import {
  parseWorkflowFile,
  WorkflowFrontMatterSchema,
} from "../../src/workflow/workflow-file.js";
import { parsePipelineYaml } from "../../src/pipeline/parser.js";

describe("Backward Compatibility", () => {
  describe("Config backward compat", () => {
    it("accepts empty config and returns valid defaults", () => {
      const config = ConfigSchema.parse({});
      expect(config.agent.type).toBe("claude-code");
      expect(config.agent.timeout).toBe("30m");
      expect(config.container.resources.memory).toBe("4g");
      expect(config.orchestration.mode).toBe("single");
    });

    it("accepts minimal config with only agent.type and container.image", () => {
      const config = ConfigSchema.parse({
        agent: { type: "codex" },
        container: { image: "my-image:latest" },
      });
      expect(config.agent.type).toBe("codex");
      expect(config.container.image).toBe("my-image:latest");
      // All other fields should have defaults
      expect(config.agent.model).toBe("");
      expect(config.repo.exclude).toContain("node_modules/");
      expect(config.commit.message.prefix).toBe("[forge]");
    });

    it("accepts config with agent/container/repo sections but no orchestrator", () => {
      const config = ConfigSchema.parse({
        agent: { type: "claude-code", model: "sonnet", timeout: "15m" },
        container: {
          image: "node:20",
          network: { mode: "allowlist", allow: ["api.anthropic.com"] },
        },
        repo: { branch: { base: "develop" }, exclude: ["vendor/"] },
      });
      expect(config.agent.model).toBe("sonnet");
      expect(config.container.network.mode).toBe("allowlist");
      expect(config.repo.branch.base).toBe("develop");
      // Orchestrator defaults
      expect(config.orchestrator.enabled).toBe(false);
      expect(config.orchestrator.max_concurrent_agents).toBe(3);
    });
  });

  describe("Workflow resolution backward compat", () => {
    it('resolveWorkflow("code") returns a valid workflow definition', () => {
      const workflow = getWorkflow("code");
      expect(workflow.name).toBe("code");
      expect(workflow.container.image).toBeDefined();
      expect(workflow.output.mode).toBe("git");
    });

    it("all built-in workflows are resolvable", () => {
      for (const name of [
        "code",
        "research",
        "content",
        "data",
        "ops",
        "general",
      ]) {
        const workflow = getWorkflow(name);
        expect(workflow.name).toBe(name);
      }
    });

    it("unknown workflow throws descriptive error", () => {
      expect(() => getWorkflow("nonexistent")).toThrow(/Unknown workflow/);
    });
  });

  describe("WORKFLOW.md backward compat", () => {
    it("parseWorkflowFile works with front matter that has no validation section", () => {
      const content = `---
agent:
  type: claude-code
  model: sonnet
---
Do the task.`;
      const { frontMatter, body } = parseWorkflowFile(content);
      expect(frontMatter.agent).toEqual({ type: "claude-code", model: "sonnet" });
      expect(body).toBe("Do the task.");
    });

    it("WorkflowFrontMatterSchema.parse({}) succeeds with all fields optional", () => {
      const result = WorkflowFrontMatterSchema.parse({});
      expect(result).toBeDefined();
      // No required fields means empty object is valid
      expect(result.tracker).toBeUndefined();
      expect(result.agent).toBeUndefined();
      expect(result.validation).toBeUndefined();
    });

    it("WorkflowFrontMatterSchema accepts front matter with only agent section", () => {
      const result = WorkflowFrontMatterSchema.parse({
        agent: { type: "claude-code", timeout: "20m" },
      });
      expect(result.agent?.type).toBe("claude-code");
      expect(result.validation).toBeUndefined();
    });

    it("WorkflowFrontMatterSchema accepts front matter with validation section", () => {
      const result = WorkflowFrontMatterSchema.parse({
        validation: {
          steps: [{ name: "test", command: "npm test" }],
          on_failure: "abandon",
        },
      });
      expect(result.validation?.steps).toHaveLength(1);
      expect(result.validation?.on_failure).toBe("abandon");
    });

    it("WorkflowFrontMatterSchema rejects unknown top-level keys (strict mode)", () => {
      expect(() =>
        WorkflowFrontMatterSchema.parse({ unknown_key: "value" }),
      ).toThrow();
    });
  });

  describe("Pipeline backward compat", () => {
    it("parsePipelineYaml accepts existing pipeline format", () => {
      const yamlContent = `
name: test-pipeline
description: A test pipeline
defaults:
  workflow: code
  agent: claude-code
nodes:
  - id: step-one
    task: "Do the first thing"
  - id: step-two
    task: "Do the second thing"
    depends_on:
      - step-one
`;
      const pipeline = parsePipelineYaml(yamlContent);
      expect(pipeline.name).toBe("test-pipeline");
      expect(pipeline.nodes).toHaveLength(2);
      expect(pipeline.nodes[1].depends_on).toEqual(["step-one"]);
    });

    it("parsePipelineYaml accepts pipeline with pipe config", () => {
      const yamlContent = `
name: pipe-pipeline
nodes:
  - id: analyze
    task: "Analyze the code"
    pipe:
      mode: context
  - id: implement
    task: "Implement changes"
    depends_on:
      - analyze
`;
      const pipeline = parsePipelineYaml(yamlContent);
      expect(pipeline.nodes[0].pipe?.mode).toBe("context");
    });

    it("parsePipelineYaml rejects invalid pipeline (no nodes)", () => {
      expect(() =>
        parsePipelineYaml(`name: bad\nnodes: []`),
      ).toThrow();
    });
  });
});
