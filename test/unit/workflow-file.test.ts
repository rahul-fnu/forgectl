import { describe, it, expect, vi } from "vitest";
import { ZodError } from "zod";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

import {
  parseWorkflowFile,
  loadWorkflowFile,
  WorkflowFrontMatterSchema,
  DEFAULT_PROMPT_TEMPLATE,
} from "../../src/workflow/workflow-file.js";
import { readFile } from "node:fs/promises";

const mockReadFile = vi.mocked(readFile);

describe("parseWorkflowFile", () => {
  it("parses YAML front matter and body", () => {
    const content = `---
extends: code
tracker:
  poll_interval_ms: 5000
---
Do {{issue.title}}`;
    const result = parseWorkflowFile(content);
    expect(result.frontMatter).toEqual({
      extends: "code",
      tracker: { poll_interval_ms: 5000 },
    });
    expect(result.body).toBe("Do {{issue.title}}");
  });

  it("throws on missing front matter delimiters", () => {
    expect(() => parseWorkflowFile("no front matter")).toThrow(
      /missing.*---.*delimiter/i,
    );
  });

  it("handles empty front matter", () => {
    const result = parseWorkflowFile("---\n---\n");
    expect(result.frontMatter).toEqual({});
    expect(result.body).toBe("");
  });

  it("does not split on --- horizontal rules after front matter", () => {
    const content = `---
extends: code
---
Some text

---

More text after horizontal rule`;
    const result = parseWorkflowFile(content);
    expect(result.frontMatter).toEqual({ extends: "code" });
    expect(result.body).toContain("---");
    expect(result.body).toContain("More text after horizontal rule");
  });
});

describe("WorkflowFrontMatterSchema", () => {
  it("accepts valid extends field", () => {
    const result = WorkflowFrontMatterSchema.parse({ extends: "code" });
    expect(result.extends).toBe("code");
  });

  it("rejects unknown keys (strict mode)", () => {
    expect(() =>
      WorkflowFrontMatterSchema.parse({ unknown_key: true }),
    ).toThrow(ZodError);
  });

  it("validates tracker partial (no superRefine)", () => {
    const result = WorkflowFrontMatterSchema.parse({
      tracker: { kind: "github", token: "$GH", repo: "o/r" },
    });
    expect(result.tracker?.kind).toBe("github");
  });

  it("accepts empty object", () => {
    const result = WorkflowFrontMatterSchema.parse({});
    expect(result).toBeDefined();
  });

  it("accepts polling config", () => {
    const result = WorkflowFrontMatterSchema.parse({
      polling: { interval_ms: 5000 },
    });
    expect(result.polling?.interval_ms).toBe(5000);
  });

  it("accepts concurrency config", () => {
    const result = WorkflowFrontMatterSchema.parse({
      concurrency: { max_agents: 4 },
    });
    expect(result.concurrency?.max_agents).toBe(4);
  });

  it("accepts agent config", () => {
    const result = WorkflowFrontMatterSchema.parse({
      agent: { type: "claude-code", model: "opus", timeout: "30m" },
    });
    expect(result.agent?.type).toBe("claude-code");
  });
});

describe("loadWorkflowFile", () => {
  it("throws on nonexistent file", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT: no such file"));
    await expect(loadWorkflowFile("/nonexistent/WORKFLOW.md")).rejects.toThrow();
  });

  it("returns DEFAULT_PROMPT_TEMPLATE when body is empty", async () => {
    mockReadFile.mockResolvedValueOnce("---\nextends: code\n---\n");
    const result = await loadWorkflowFile("/fake/WORKFLOW.md");
    expect(result.promptTemplate).toBe(DEFAULT_PROMPT_TEMPLATE);
    expect(result.config.extends).toBe("code");
  });

  it("returns body as promptTemplate for valid file", async () => {
    mockReadFile.mockResolvedValueOnce(
      "---\nextends: code\n---\nDo {{issue.title}}",
    );
    const result = await loadWorkflowFile("/fake/WORKFLOW.md");
    expect(result.promptTemplate).toBe("Do {{issue.title}}");
    expect(result.config.extends).toBe("code");
  });
});
