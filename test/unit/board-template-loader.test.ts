import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTemplatePipeline } from "../../src/board/template-loader.js";

describe("loadTemplatePipeline", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads yaml pipeline and interpolates params", () => {
    const root = mkdtempSync(join(tmpdir(), "forgectl-template-yaml-"));
    tempDirs.push(root);

    const boardPath = join(root, "board.yaml");
    const pipelinePath = join(root, "pipe.yaml");

    writeFileSync(boardPath, "id: test\n", "utf-8");
    writeFileSync(pipelinePath, `
name: feature-{{ticket}}
defaults:
  repo: "{{repo}}"
nodes:
  - id: a
    task: "Implement {{ticket}}"
`, "utf-8");

    const loaded = loadTemplatePipeline({
      source: { format: "yaml", path: "./pipe.yaml" },
      params: {
        defaults: { repo: "/tmp/default" },
      },
    }, {
      ticket: "AUTH-22",
      repo: "/tmp/repo",
    }, boardPath);

    expect(loaded.pipeline.name).toBe("feature-AUTH-22");
    expect(loaded.pipeline.defaults?.repo).toBe("/tmp/repo");
    expect(loaded.pipeline.nodes[0].task).toBe("Implement AUTH-22");
  });

  it("loads WORKFLOW.md body into single-node pipeline", () => {
    const root = mkdtempSync(join(tmpdir(), "forgectl-template-md-"));
    tempDirs.push(root);

    const boardPath = join(root, "board.yaml");
    const workflowPath = join(root, "WORKFLOW.md");

    writeFileSync(boardPath, "id: test\n", "utf-8");
    writeFileSync(workflowPath, `---
name: workflow-card
workflow: content
agent: codex
---
Write summary for {{topic}}
`, "utf-8");

    const loaded = loadTemplatePipeline({
      source: { format: "workflow-md", path: "./WORKFLOW.md" },
      params: {
        defaults: { topic: "default topic" },
      },
    }, {
      topic: "release notes",
    }, boardPath);

    expect(loaded.pipeline.name).toBe("workflow-card");
    expect(loaded.pipeline.defaults?.workflow).toBe("content");
    expect(loaded.pipeline.defaults?.agent).toBe("codex");
    expect(loaded.pipeline.nodes).toHaveLength(1);
    expect(loaded.pipeline.nodes[0].task).toContain("release notes");
  });

  it("loads WORKFLOW.md pipeline reference", () => {
    const root = mkdtempSync(join(tmpdir(), "forgectl-template-md-ref-"));
    tempDirs.push(root);

    const boardPath = join(root, "board.yaml");
    const workflowPath = join(root, "WORKFLOW.md");
    const pipelinePath = join(root, "pipelines", "task.yaml");

    writeFileSync(boardPath, "id: test\n", "utf-8");
    writeFileSync(workflowPath, `---
pipeline: ./pipelines/task.yaml
---
ignored body
`, "utf-8");

    mkdirSync(join(root, "pipelines"), { recursive: true });
    writeFileSync(pipelinePath, `
name: ref-{{ticket}}
nodes:
  - id: task
    task: "Ship {{ticket}}"
`, "utf-8");

    const loaded = loadTemplatePipeline({
      source: { format: "workflow-md", path: "./WORKFLOW.md" },
    }, {
      ticket: "ENG-9",
    }, boardPath);

    expect(loaded.pipeline.name).toBe("ref-ENG-9");
    expect(loaded.pipeline.nodes[0].task).toBe("Ship ENG-9");
  });
});
