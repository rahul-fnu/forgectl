import { describe, it, expect } from "vitest";
import { browserResearchWorkflow } from "../../src/workflow/builtins/browser-research.js";

describe("browser-research workflow", () => {
  it("has correct name", () => {
    expect(browserResearchWorkflow.name).toBe("browser-research");
  });

  it("uses forgectl/research-browser image", () => {
    expect(browserResearchWorkflow.container.image).toBe("forgectl/research-browser");
  });

  it("uses files output mode with /output path", () => {
    expect(browserResearchWorkflow.output.mode).toBe("files");
    expect(browserResearchWorkflow.output.path).toBe("/output");
  });

  it("has 3 validation steps with correct names", () => {
    expect(browserResearchWorkflow.validation.steps).toHaveLength(3);
    const names = browserResearchWorkflow.validation.steps.map((s) => s.name);
    expect(names).toEqual(["report-exists", "has-content", "has-sources"]);
  });

  it("system prompt contains key research instructions", () => {
    expect(browserResearchWorkflow.system).toContain("markdown");
    expect(browserResearchWorkflow.system).toContain("/output");
    expect(browserResearchWorkflow.system).toContain("report.md");
    expect(browserResearchWorkflow.system.toLowerCase()).toContain("cite");
  });

  it("has review enabled", () => {
    expect(browserResearchWorkflow.review.enabled).toBe(true);
  });

  it("has full autonomy", () => {
    expect(browserResearchWorkflow.autonomy).toBe("full");
  });

  it("collects markdown, json, png, and jpg files", () => {
    expect(browserResearchWorkflow.output.collect).toContain("**/*.md");
    expect(browserResearchWorkflow.output.collect).toContain("**/*.json");
    expect(browserResearchWorkflow.output.collect).toContain("**/*.png");
    expect(browserResearchWorkflow.output.collect).toContain("**/*.jpg");
  });

  it("uses files input mode with /input mount", () => {
    expect(browserResearchWorkflow.input.mode).toBe("files");
    expect(browserResearchWorkflow.input.mountPath).toBe("/input");
  });

  it("includes browser-use in tools", () => {
    expect(browserResearchWorkflow.tools).toContain("browser-use");
  });
});
