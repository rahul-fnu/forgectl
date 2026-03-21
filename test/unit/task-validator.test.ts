import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateTaskSpec } from "../../src/task/validator.js";
import type { TaskSpec } from "../../src/task/types.js";

function makeSpec(overrides?: Partial<TaskSpec>): TaskSpec {
  return {
    id: "test-task",
    title: "Test Task",
    context: {
      files: ["src/**/*.ts"],
    },
    constraints: [],
    acceptance: [
      { run: "npm test", description: "Tests pass" },
    ],
    decomposition: { strategy: "auto" },
    effort: { max_turns: 50 },
    ...overrides,
  };
}

describe("validateTaskSpec", () => {
  it("returns valid for a well-formed spec", () => {
    const result = validateTaskSpec(makeSpec());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("warns when no acceptance criteria have run commands", () => {
    const spec = makeSpec({
      acceptance: [{ description: "Looks good" }],
    });
    const result = validateTaskSpec(spec);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.field === "acceptance")).toBe(true);
  });

  it("warns when max_turns is not set", () => {
    const spec = makeSpec({ effort: {} });
    const result = validateTaskSpec(spec);
    expect(result.warnings.some((w) => w.field === "effort.max_turns")).toBe(true);
  });

  it("warns when decomposition max_depth > 3", () => {
    const spec = makeSpec({ decomposition: { strategy: "auto", max_depth: 4 } });
    const result = validateTaskSpec(spec);
    expect(result.warnings.some((w) => w.field === "decomposition.max_depth")).toBe(true);
  });

  it("does not warn when decomposition max_depth <= 3", () => {
    const spec = makeSpec({ decomposition: { strategy: "auto", max_depth: 3 } });
    const result = validateTaskSpec(spec);
    expect(result.warnings.some((w) => w.field === "decomposition.max_depth")).toBe(false);
  });

  it("does not warn about max_depth for non-auto strategy", () => {
    const spec = makeSpec({ decomposition: { strategy: "manual", max_depth: 5 } });
    const result = validateTaskSpec(spec);
    expect(result.warnings.some((w) => w.field === "decomposition.max_depth")).toBe(false);
  });

  it("errors on empty run command", () => {
    const spec = makeSpec({
      acceptance: [{ run: "   ", description: "Bad" }],
    });
    const result = validateTaskSpec(spec);
    expect(result.errors.some((e) => e.field.includes("acceptance") && e.field.includes("run"))).toBe(true);
  });
});

describe("validateTaskSpec with repoRoot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-validator-"));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "index.ts"), "export {}");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("validates file patterns that match", () => {
    const spec = makeSpec({ context: { files: ["src/*.ts"] } });
    const result = validateTaskSpec(spec, { repoRoot: tmpDir });
    expect(result.errors.filter((e) => e.field === "context.files")).toEqual([]);
  });

  it("errors on file patterns that do not match", () => {
    const spec = makeSpec({ context: { files: ["nonexistent/**/*.go"] } });
    const result = validateTaskSpec(spec, { repoRoot: tmpDir });
    expect(result.errors.some((e) => e.field === "context.files")).toBe(true);
  });

  it("combines multiple warnings and errors", () => {
    const spec = makeSpec({
      context: { files: ["nonexistent/**/*.go"] },
      acceptance: [{ description: "Manual check only" }],
      effort: {},
      decomposition: { strategy: "auto", max_depth: 5 },
    });
    const result = validateTaskSpec(spec, { repoRoot: tmpDir });
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });
});
