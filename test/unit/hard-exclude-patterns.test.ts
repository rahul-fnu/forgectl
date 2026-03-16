import { describe, it, expect } from "vitest";
import { HARD_EXCLUDE_PATTERNS } from "../../src/output/git.js";

describe("HARD_EXCLUDE_PATTERNS", () => {
  it("includes node_modules", () => {
    expect(HARD_EXCLUDE_PATTERNS).toContain("node_modules/");
  });

  it("includes Rust target/", () => {
    expect(HARD_EXCLUDE_PATTERNS).toContain("target/");
  });

  it("includes dist/", () => {
    expect(HARD_EXCLUDE_PATTERNS).toContain("dist/");
  });

  it("includes build/", () => {
    expect(HARD_EXCLUDE_PATTERNS).toContain("build/");
  });

  it("includes .rlib (Rust library)", () => {
    expect(HARD_EXCLUDE_PATTERNS).toContain("*.rlib");
  });

  it("includes native object files (*.o, *.so, *.dylib)", () => {
    expect(HARD_EXCLUDE_PATTERNS).toContain("*.o");
    expect(HARD_EXCLUDE_PATTERNS).toContain("*.so");
    expect(HARD_EXCLUDE_PATTERNS).toContain("*.dylib");
  });

  it("includes Windows executables (*.exe, *.dll)", () => {
    expect(HARD_EXCLUDE_PATTERNS).toContain("*.exe");
    expect(HARD_EXCLUDE_PATTERNS).toContain("*.dll");
  });

  it("includes Java class files (*.class)", () => {
    expect(HARD_EXCLUDE_PATTERNS).toContain("*.class");
  });

  it("includes Python cache (__pycache__/, *.pyc)", () => {
    expect(HARD_EXCLUDE_PATTERNS).toContain("__pycache__/");
    expect(HARD_EXCLUDE_PATTERNS).toContain("*.pyc");
  });

  it("includes Next.js build dir (.next/)", () => {
    expect(HARD_EXCLUDE_PATTERNS).toContain(".next/");
  });

  it("includes coverage dir (coverage/)", () => {
    expect(HARD_EXCLUDE_PATTERNS).toContain("coverage/");
  });

  it("includes *.log", () => {
    expect(HARD_EXCLUDE_PATTERNS).toContain("*.log");
  });

  it("is a non-empty array", () => {
    expect(HARD_EXCLUDE_PATTERNS.length).toBeGreaterThan(10);
  });

  it("has no duplicate entries", () => {
    const unique = new Set(HARD_EXCLUDE_PATTERNS);
    expect(unique.size).toBe(HARD_EXCLUDE_PATTERNS.length);
  });
});

describe("expanded default excludes in schema", () => {
  it("includes all original patterns", async () => {
    const { ConfigSchema } = await import("../../src/config/schema.js");
    const defaults = ConfigSchema.parse({}).repo.exclude;
    expect(defaults).toContain("node_modules/");
    expect(defaults).toContain("dist/");
    expect(defaults).toContain("build/");
    expect(defaults).toContain("*.log");
    expect(defaults).toContain(".env");
    expect(defaults).toContain(".env.*");
  });

  it("includes new artifact patterns", async () => {
    const { ConfigSchema } = await import("../../src/config/schema.js");
    const defaults = ConfigSchema.parse({}).repo.exclude;
    expect(defaults).toContain("target/");
    expect(defaults).toContain("*.rlib");
    expect(defaults).toContain("*.o");
    expect(defaults).toContain("*.so");
    expect(defaults).toContain("*.dylib");
    expect(defaults).toContain("*.exe");
    expect(defaults).toContain("*.dll");
    expect(defaults).toContain("*.class");
    expect(defaults).toContain("__pycache__/");
    expect(defaults).toContain("*.pyc");
    expect(defaults).toContain(".next/");
    expect(defaults).toContain("coverage/");
  });

  it("user config can override excludes (but HARD_EXCLUDE always applied in git.ts)", async () => {
    const { ConfigSchema } = await import("../../src/config/schema.js");
    const config = ConfigSchema.parse({ repo: { exclude: ["custom/"] } });
    expect(config.repo.exclude).toEqual(["custom/"]);
    // Hard excludes are applied at git.ts level, not schema level
    expect(config.repo.exclude).not.toContain("target/");
  });
});
