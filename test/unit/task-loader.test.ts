import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTaskSpec, loadTaskSpecFromString, findTaskSpecs } from "../../src/task/loader.js";

const validYaml = `
id: test-task
title: Test Task
context:
  files:
    - "src/**/*.ts"
acceptance:
  - run: "npm test"
    description: "Tests pass"
`;

const invalidYaml = `
id: test-task
title: Test Task
context:
  files: []
acceptance: []
`;

describe("loadTaskSpecFromString", () => {
  it("loads valid YAML into a TaskSpec", () => {
    const spec = loadTaskSpecFromString(validYaml);
    expect(spec.id).toBe("test-task");
    expect(spec.title).toBe("Test Task");
    expect(spec.context.files).toEqual(["src/**/*.ts"]);
    expect(spec.acceptance).toHaveLength(1);
    expect(spec.acceptance[0].run).toBe("npm test");
  });

  it("applies default values", () => {
    const spec = loadTaskSpecFromString(validYaml);
    expect(spec.constraints).toEqual([]);
    expect(spec.decomposition.strategy).toBe("auto");
  });

  it("throws on invalid YAML syntax", () => {
    expect(() => loadTaskSpecFromString("{ bad yaml: [")).toThrow();
  });

  it("throws on non-object YAML", () => {
    expect(() => loadTaskSpecFromString("just a string")).toThrow("Invalid YAML: expected an object");
    expect(() => loadTaskSpecFromString("42")).toThrow("Invalid YAML: expected an object");
  });

  it("throws with field-level errors for schema violations", () => {
    try {
      loadTaskSpecFromString(invalidYaml);
      expect.fail("Should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("files");
    }
  });
});

describe("loadTaskSpec (file)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-loader-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads a valid task spec from a file", () => {
    const filePath = join(tmpDir, "test.task.yaml");
    writeFileSync(filePath, validYaml);
    const spec = loadTaskSpec(filePath);
    expect(spec.id).toBe("test-task");
  });

  it("throws when file does not exist", () => {
    expect(() => loadTaskSpec(join(tmpDir, "nonexistent.yaml"))).toThrow();
  });
});

describe("findTaskSpecs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-finder-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds .task.yaml and .task.yml files", () => {
    writeFileSync(join(tmpDir, "a.task.yaml"), validYaml);
    writeFileSync(join(tmpDir, "b.task.yml"), validYaml);
    writeFileSync(join(tmpDir, "c.yaml"), "not a task spec");
    writeFileSync(join(tmpDir, "d.txt"), "not yaml");

    const results = findTaskSpecs(tmpDir);
    expect(results).toHaveLength(2);
    expect(results[0]).toContain("a.task.yaml");
    expect(results[1]).toContain("b.task.yml");
  });

  it("returns empty array when no task specs found", () => {
    writeFileSync(join(tmpDir, "normal.yaml"), "not: a task");
    expect(findTaskSpecs(tmpDir)).toEqual([]);
  });

  it("ignores directories", () => {
    mkdirSync(join(tmpDir, "sub.task.yaml"));
    expect(findTaskSpecs(tmpDir)).toEqual([]);
  });
});
