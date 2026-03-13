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

  it("accepts validation section with steps and on_failure", () => {
    const result = WorkflowFrontMatterSchema.parse({
      validation: {
        steps: [{ name: "test", command: "npm test" }],
        on_failure: "abandon",
      },
    });
    expect(result.validation?.steps).toHaveLength(1);
    expect(result.validation?.steps[0].name).toBe("test");
    expect(result.validation?.steps[0].command).toBe("npm test");
    expect(result.validation?.on_failure).toBe("abandon");
  });

  it("defaults validation steps to empty array and on_failure to abandon", () => {
    const result = WorkflowFrontMatterSchema.parse({
      validation: {},
    });
    expect(result.validation?.steps).toEqual([]);
    expect(result.validation?.on_failure).toBe("abandon");
  });

  it("rejects validation with invalid step (missing command)", () => {
    expect(() =>
      WorkflowFrontMatterSchema.parse({
        validation: {
          steps: [{ name: "test" }],
        },
      }),
    ).toThrow(ZodError);
  });

  it("accepts validation with multiple steps and retries", () => {
    const result = WorkflowFrontMatterSchema.parse({
      validation: {
        steps: [
          { name: "typecheck", command: "npm run typecheck", retries: 2 },
          { name: "test", command: "npm test", retries: 5 },
        ],
        on_failure: "output-wip",
      },
    });
    expect(result.validation?.steps).toHaveLength(2);
    expect(result.validation?.steps[0].retries).toBe(2);
    expect(result.validation?.steps[1].retries).toBe(5);
    expect(result.validation?.on_failure).toBe("output-wip");
  });

  it("accepts skills array in front matter", () => {
    const result = WorkflowFrontMatterSchema.parse({
      skills: ["code-review", "testing"],
    });
    expect(result.skills).toEqual(["code-review", "testing"]);
  });

  it("returns undefined for skills when not specified", () => {
    const result = WorkflowFrontMatterSchema.parse({});
    expect(result.skills).toBeUndefined();
  });

  it("strict() does NOT reject skills key", () => {
    // This is the key correctness check — skills must be in schema before .strict()
    expect(() =>
      WorkflowFrontMatterSchema.parse({ skills: ["a", "b"] }),
    ).not.toThrow(ZodError);
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
