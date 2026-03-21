import { describe, it, expect } from "vitest";
import { scaffoldTaskSpec } from "../../src/task/scaffold.js";
import { loadTaskSpecFromString } from "../../src/task/loader.js";

describe("scaffoldTaskSpec", () => {
  it("generates valid YAML that round-trips through validation", () => {
    const yaml = scaffoldTaskSpec({ id: "my-task", title: "My Task" });
    // The scaffold includes TODO strings which are valid — it should parse and validate
    const spec = loadTaskSpecFromString(yaml);
    expect(spec.id).toBe("my-task");
    expect(spec.title).toBe("My Task");
  });

  it("includes the ID in output", () => {
    const yaml = scaffoldTaskSpec({ id: "test-id", title: "Test" });
    expect(yaml).toContain("test-id");
  });

  it("includes file patterns in context", () => {
    const yaml = scaffoldTaskSpec({ id: "t", title: "T", files: ["lib/**/*.js", "test/**/*.js"] });
    expect(yaml).toContain("lib/**/*.js");
    expect(yaml).toContain("test/**/*.js");
  });

  it("uses default file patterns when none specified", () => {
    const yaml = scaffoldTaskSpec({ id: "t", title: "T" });
    expect(yaml).toContain("src/**/*.ts");
  });

  it("includes constraints when provided", () => {
    const yaml = scaffoldTaskSpec({ id: "t", title: "T", constraints: ["No API changes"] });
    const spec = loadTaskSpecFromString(yaml);
    expect(spec.constraints).toContain("No API changes");
  });

  it("includes TODO comments", () => {
    const yaml = scaffoldTaskSpec({ id: "t", title: "T" });
    expect(yaml).toContain("TODO");
  });

  it("includes header comments explaining fields", () => {
    const yaml = scaffoldTaskSpec({ id: "t", title: "T" });
    expect(yaml).toContain("# Task Specification");
    expect(yaml).toContain("id");
    expect(yaml).toContain("title");
    expect(yaml).toContain("acceptance");
  });

  it("sets reasonable defaults for effort", () => {
    const yaml = scaffoldTaskSpec({ id: "t", title: "T" });
    const spec = loadTaskSpecFromString(yaml);
    expect(spec.effort.max_turns).toBe(50);
    expect(spec.effort.timeout).toBe("30m");
  });
});
