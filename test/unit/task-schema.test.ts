import { describe, it, expect } from "vitest";
import { TaskSpecSchema, AcceptanceCriterionSchema, DecompositionConfigSchema, EffortConfigSchema } from "../../src/task/schema.js";

const validSpec = {
  id: "fix-auth-bug",
  title: "Fix authentication bypass in login endpoint",
  context: {
    files: ["src/auth/**/*.ts"],
  },
  acceptance: [
    { run: "npm test", description: "All tests pass" },
  ],
};

describe("TaskSpecSchema", () => {
  it("parses a valid spec with all defaults", () => {
    const result = TaskSpecSchema.parse(validSpec);
    expect(result.id).toBe("fix-auth-bug");
    expect(result.title).toBe("Fix authentication bypass in login endpoint");
    expect(result.constraints).toEqual([]);
    expect(result.decomposition.strategy).toBe("auto");
    expect(result.effort).toEqual({});
    expect(result.metadata).toBeUndefined();
  });

  it("parses a fully specified spec", () => {
    const full = {
      ...validSpec,
      description: "Detailed description",
      context: {
        files: ["src/**/*.ts"],
        docs: ["docs/auth.md"],
        modules: ["auth-module"],
        related_tasks: ["setup-db"],
      },
      constraints: ["Do not change public API"],
      decomposition: { strategy: "manual", max_depth: 2 },
      effort: { max_turns: 100, max_review_rounds: 3, timeout: "1h" },
      metadata: { priority: "high", sprint: "23" },
    };
    const result = TaskSpecSchema.parse(full);
    expect(result.context.docs).toEqual(["docs/auth.md"]);
    expect(result.decomposition.strategy).toBe("manual");
    expect(result.effort.max_turns).toBe(100);
    expect(result.metadata?.priority).toBe("high");
  });

  it("rejects missing required fields", () => {
    expect(() => TaskSpecSchema.parse({})).toThrow();
    expect(() => TaskSpecSchema.parse({ id: "test" })).toThrow();
    expect(() => TaskSpecSchema.parse({ id: "test", title: "T" })).toThrow();
  });

  it("rejects invalid ID format", () => {
    expect(() => TaskSpecSchema.parse({ ...validSpec, id: "Bad-Id" })).toThrow();
    expect(() => TaskSpecSchema.parse({ ...validSpec, id: "-starts-with-dash" })).toThrow();
    expect(() => TaskSpecSchema.parse({ ...validSpec, id: "has spaces" })).toThrow();
    expect(() => TaskSpecSchema.parse({ ...validSpec, id: "has_underscore" })).toThrow();
  });

  it("accepts valid ID formats", () => {
    expect(TaskSpecSchema.parse({ ...validSpec, id: "abc" }).id).toBe("abc");
    expect(TaskSpecSchema.parse({ ...validSpec, id: "a-b-c" }).id).toBe("a-b-c");
    expect(TaskSpecSchema.parse({ ...validSpec, id: "task123" }).id).toBe("task123");
    expect(TaskSpecSchema.parse({ ...validSpec, id: "0-start" }).id).toBe("0-start");
  });

  it("rejects empty title", () => {
    expect(() => TaskSpecSchema.parse({ ...validSpec, title: "" })).toThrow();
  });

  it("rejects title over 200 characters", () => {
    expect(() => TaskSpecSchema.parse({ ...validSpec, title: "x".repeat(201) })).toThrow();
  });

  it("rejects empty files array", () => {
    expect(() => TaskSpecSchema.parse({ ...validSpec, context: { files: [] } })).toThrow();
  });

  it("rejects empty acceptance array", () => {
    expect(() => TaskSpecSchema.parse({ ...validSpec, acceptance: [] })).toThrow();
  });

  it("applies default values", () => {
    const result = TaskSpecSchema.parse(validSpec);
    expect(result.constraints).toEqual([]);
    expect(result.decomposition).toEqual({ strategy: "auto" });
    expect(result.effort).toEqual({});
  });
});

describe("AcceptanceCriterionSchema", () => {
  it("accepts criterion with run", () => {
    expect(AcceptanceCriterionSchema.parse({ run: "npm test" })).toEqual({ run: "npm test" });
  });

  it("accepts criterion with assert", () => {
    expect(AcceptanceCriterionSchema.parse({ assert: "file_exists('out.json')" })).toBeTruthy();
  });

  it("accepts criterion with description only", () => {
    expect(AcceptanceCriterionSchema.parse({ description: "Code is clean" })).toBeTruthy();
  });

  it("accepts criterion with all fields", () => {
    const c = AcceptanceCriterionSchema.parse({ run: "npm test", assert: "exit_0", description: "Tests pass" });
    expect(c.run).toBe("npm test");
    expect(c.assert).toBe("exit_0");
    expect(c.description).toBe("Tests pass");
  });

  it("rejects empty criterion", () => {
    expect(() => AcceptanceCriterionSchema.parse({})).toThrow();
  });
});

describe("DecompositionConfigSchema", () => {
  it("defaults strategy to auto", () => {
    expect(DecompositionConfigSchema.parse({}).strategy).toBe("auto");
  });

  it("rejects invalid strategy", () => {
    expect(() => DecompositionConfigSchema.parse({ strategy: "invalid" })).toThrow();
  });

  it("rejects max_depth out of range", () => {
    expect(() => DecompositionConfigSchema.parse({ strategy: "auto", max_depth: 0 })).toThrow();
    expect(() => DecompositionConfigSchema.parse({ strategy: "auto", max_depth: 6 })).toThrow();
  });

  it("accepts max_depth in range", () => {
    expect(DecompositionConfigSchema.parse({ strategy: "auto", max_depth: 1 }).max_depth).toBe(1);
    expect(DecompositionConfigSchema.parse({ strategy: "auto", max_depth: 5 }).max_depth).toBe(5);
  });
});

describe("EffortConfigSchema", () => {
  it("accepts valid duration formats", () => {
    expect(EffortConfigSchema.parse({ timeout: "30s" }).timeout).toBe("30s");
    expect(EffortConfigSchema.parse({ timeout: "5m" }).timeout).toBe("5m");
    expect(EffortConfigSchema.parse({ timeout: "1h" }).timeout).toBe("1h");
    expect(EffortConfigSchema.parse({ timeout: "7d" }).timeout).toBe("7d");
  });

  it("rejects invalid duration formats", () => {
    expect(() => EffortConfigSchema.parse({ timeout: "30" })).toThrow();
    expect(() => EffortConfigSchema.parse({ timeout: "abc" })).toThrow();
    expect(() => EffortConfigSchema.parse({ timeout: "30x" })).toThrow();
    expect(() => EffortConfigSchema.parse({ timeout: "" })).toThrow();
  });

  it("rejects max_turns out of range", () => {
    expect(() => EffortConfigSchema.parse({ max_turns: 0 })).toThrow();
    expect(() => EffortConfigSchema.parse({ max_turns: 201 })).toThrow();
  });

  it("rejects max_review_rounds out of range", () => {
    expect(() => EffortConfigSchema.parse({ max_review_rounds: -1 })).toThrow();
    expect(() => EffortConfigSchema.parse({ max_review_rounds: 6 })).toThrow();
  });
});
