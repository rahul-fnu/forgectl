import { describe, it, expect } from "vitest";
import { getWorkflow, listWorkflowNames, listWorkflows } from "../../src/workflow/registry.js";

describe("workflow registry", () => {
  it("lists all 10 built-in workflow names", () => {
    const names = listWorkflowNames();
    expect(names).toContain("code");
    expect(names).toContain("research");
    expect(names).toContain("content");
    expect(names).toContain("data");
    expect(names).toContain("ops");
    expect(names).toContain("general");
    expect(names).toContain("browser-research");
    expect(names).toContain("code-python");
    expect(names).toContain("code-go");
    expect(names).toContain("code-rust");
    expect(names).toHaveLength(10);
  });

  it("lists all 10 built-in workflow definitions", () => {
    const workflows = listWorkflows();
    expect(workflows).toHaveLength(10);
    for (const w of workflows) {
      expect(w.name).toBeTruthy();
      expect(w.container.image).toBeTruthy();
    }
  });

  it("getWorkflow('code') returns valid definition", () => {
    const workflow = getWorkflow("code");
    expect(workflow.name).toBe("code");
    expect(workflow.description).toContain("code");
    expect(workflow.container.image).toBe("forgectl/code-node20");
    expect(workflow.input.mode).toBe("repo");
    expect(workflow.input.mountPath).toBe("/workspace");
    expect(workflow.output.mode).toBe("git");
    expect(workflow.validation.steps.length).toBeGreaterThan(0);
    expect(workflow.review.enabled).toBe(true);
  });

  it("getWorkflow('research') returns valid definition", () => {
    const workflow = getWorkflow("research");
    expect(workflow.name).toBe("research");
    expect(workflow.container.image).toBe("forgectl/research-browser");
    expect(workflow.input.mode).toBe("files");
    expect(workflow.output.mode).toBe("files");
    expect(workflow.output.path).toBe("/output");
  });

  it("getWorkflow('content') returns valid definition", () => {
    const workflow = getWorkflow("content");
    expect(workflow.name).toBe("content");
    expect(workflow.input.mode).toBe("files");
    expect(workflow.output.mode).toBe("files");
    expect(workflow.review.enabled).toBe(true);
  });

  it("getWorkflow('data') returns valid definition", () => {
    const workflow = getWorkflow("data");
    expect(workflow.name).toBe("data");
    expect(workflow.input.mode).toBe("files");
    expect(workflow.output.mode).toBe("files");
    expect(workflow.review.enabled).toBe(false);
  });

  it("getWorkflow('ops') returns valid definition", () => {
    const workflow = getWorkflow("ops");
    expect(workflow.name).toBe("ops");
    expect(workflow.input.mode).toBe("repo");
    expect(workflow.output.mode).toBe("git");
    expect(workflow.review.enabled).toBe(true);
  });

  it("getWorkflow('general') returns valid definition", () => {
    const workflow = getWorkflow("general");
    expect(workflow.name).toBe("general");
    expect(workflow.input.mode).toBe("files");
    expect(workflow.output.mode).toBe("files");
    expect(workflow.review.enabled).toBe(false);
  });

  it("getWorkflow('browser-research') returns valid definition", () => {
    const workflow = getWorkflow("browser-research");
    expect(workflow.name).toBe("browser-research");
    expect(workflow.container.image).toBe("forgectl/research-browser");
    expect(workflow.input.mode).toBe("files");
    expect(workflow.output.mode).toBe("files");
    expect(workflow.output.path).toBe("/output");
    expect(workflow.validation.steps).toHaveLength(3);
    expect(workflow.review.enabled).toBe(true);
    expect(workflow.autonomy).toBe("full");
  });

  it("getWorkflow('code-python') returns valid definition", () => {
    const workflow = getWorkflow("code-python");
    expect(workflow.name).toBe("code-python");
    expect(workflow.container.image).toBe("forgectl/code-python312");
    expect(workflow.input.mode).toBe("repo");
    expect(workflow.output.mode).toBe("git");
    expect(workflow.validation.steps.length).toBeGreaterThan(0);
    expect(workflow.review.enabled).toBe(true);
  });

  it("getWorkflow('code-go') returns valid definition", () => {
    const workflow = getWorkflow("code-go");
    expect(workflow.name).toBe("code-go");
    expect(workflow.container.image).toBe("forgectl/code-go122");
    expect(workflow.input.mode).toBe("repo");
    expect(workflow.output.mode).toBe("git");
    expect(workflow.validation.steps.length).toBeGreaterThan(0);
    expect(workflow.review.enabled).toBe(true);
  });

  it("getWorkflow('code-rust') returns valid definition", () => {
    const workflow = getWorkflow("code-rust");
    expect(workflow.name).toBe("code-rust");
    expect(workflow.container.image).toBe("forgectl/code-rust");
    expect(workflow.input.mode).toBe("repo");
    expect(workflow.output.mode).toBe("git");
    expect(workflow.validation.steps.length).toBeGreaterThan(0);
    expect(workflow.review.enabled).toBe(true);
  });

  it("getWorkflow('nonexistent') throws", () => {
    expect(() => getWorkflow("nonexistent")).toThrow('Unknown workflow: "nonexistent"');
  });

  it("each built-in has required container config", () => {
    for (const name of listWorkflowNames()) {
      const w = getWorkflow(name);
      expect(w.container.image).toBeTruthy();
      expect(w.container.network.mode).toBe("open");
    }
  });
});
