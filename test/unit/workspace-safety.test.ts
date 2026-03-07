import { describe, it, expect } from "vitest";
import { sanitizeIdentifier, assertContainment } from "../../src/workspace/safety.js";
import { z } from "zod";

describe("sanitizeIdentifier", () => {
  it("replaces special characters with underscore", () => {
    expect(sanitizeIdentifier("issue#123")).toBe("issue_123");
  });

  it("leaves valid identifiers unchanged", () => {
    expect(sanitizeIdentifier("normal-id.1")).toBe("normal-id.1");
  });

  it("throws on identifiers that sanitize to empty-equivalent", () => {
    expect(() => sanitizeIdentifier("///")).toThrow();
  });

  it("throws on dot-only identifier '..'", () => {
    expect(() => sanitizeIdentifier("..")).toThrow();
  });

  it("throws on dot-only identifier '.'", () => {
    expect(() => sanitizeIdentifier(".")).toThrow();
  });

  it("throws on empty string", () => {
    expect(() => sanitizeIdentifier("")).toThrow();
  });
});

describe("assertContainment", () => {
  it("passes when target is a child of root", () => {
    expect(() => assertContainment("/root", "/root/child")).not.toThrow();
  });

  it("throws on path traversal with ..", () => {
    expect(() => assertContainment("/root", "/root/../escape")).toThrow(
      /Path traversal detected/,
    );
  });

  it("throws when target is outside root", () => {
    expect(() => assertContainment("/root", "/other")).toThrow(
      /Path traversal detected/,
    );
  });

  it("passes when target equals root", () => {
    expect(() => assertContainment("/root", "/root")).not.toThrow();
  });
});

describe("WorkspaceConfigSchema", () => {
  it("validates with defaults", async () => {
    const { WorkspaceConfigSchema } = await import(
      "../../src/config/schema.js"
    );
    const result = WorkspaceConfigSchema.parse({});
    expect(result.root).toBe("~/.forgectl/workspaces");
    expect(result.hooks).toEqual({});
    expect(result.hook_timeout).toBe("60s");
  });

  it("validates custom hooks config", async () => {
    const { WorkspaceConfigSchema } = await import(
      "../../src/config/schema.js"
    );
    const result = WorkspaceConfigSchema.parse({
      root: "/tmp/workspaces",
      hooks: {
        after_create: "echo created",
        before_run: "npm install",
      },
      hook_timeout: "30s",
    });
    expect(result.root).toBe("/tmp/workspaces");
    expect(result.hooks.after_create).toBe("echo created");
    expect(result.hooks.before_run).toBe("npm install");
  });
});
