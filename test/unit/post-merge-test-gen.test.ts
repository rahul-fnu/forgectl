import { describe, it, expect, afterEach } from "vitest";
import { findCoverageGaps } from "../../src/merge-daemon/pr-processor.js";
import { createKGDatabase, saveTestMappings, saveModules } from "../../src/kg/storage.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("findCoverageGaps", () => {
  it("exports findCoverageGaps function", () => {
    expect(typeof findCoverageGaps).toBe("function");
  });

  it("returns empty array when KG db does not exist", () => {
    const gaps = findCoverageGaps(["src/utils/helper.ts"], "/tmp/nonexistent-dir");
    expect(gaps).toEqual([]);
  });

  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function setupKG() {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-test-kg-"));
    const kgPath = join(tmpDir, ".forgectl", "kg.db");
    const db = createKGDatabase(kgPath);
    return { db, workDir: tmpDir };
  }

  it("returns all changed files as gaps when KG has no test mappings", () => {
    const { db, workDir } = setupKG();
    db.close();

    const gaps = findCoverageGaps(["src/foo.ts", "src/bar.ts"], workDir);
    expect(gaps).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("returns empty array when all changed files have test mappings", () => {
    const { db, workDir } = setupKG();
    saveTestMappings(db, [
      { sourceFile: "src/foo.ts", testFiles: ["test/foo.test.ts"], confidence: "high" },
      { sourceFile: "src/bar.ts", testFiles: ["test/bar.test.ts"], confidence: "medium" },
    ]);
    db.close();

    const gaps = findCoverageGaps(["src/foo.ts", "src/bar.ts"], workDir);
    expect(gaps).toEqual([]);
  });

  it("identifies files without test mappings as gaps", () => {
    const { db, workDir } = setupKG();
    saveTestMappings(db, [
      { sourceFile: "src/foo.ts", testFiles: ["test/foo.test.ts"], confidence: "high" },
    ]);
    db.close();

    const gaps = findCoverageGaps(["src/foo.ts", "src/bar.ts", "src/baz.ts"], workDir);
    expect(gaps).toEqual(["src/bar.ts", "src/baz.ts"]);
  });

  it("treats files with empty testFiles array as gaps", () => {
    const { db, workDir } = setupKG();
    // Manually insert a mapping with no test files (empty mapping)
    // saveTestMappings won't insert rows for empty testFiles arrays,
    // so this file will have no mappings in the db
    saveTestMappings(db, [
      { sourceFile: "src/covered.ts", testFiles: ["test/covered.test.ts"], confidence: "high" },
      { sourceFile: "src/empty.ts", testFiles: [], confidence: "low" },
    ]);
    db.close();

    const gaps = findCoverageGaps(["src/covered.ts", "src/empty.ts"], workDir);
    expect(gaps).toEqual(["src/empty.ts"]);
  });

  it("returns empty array when no changed files provided", () => {
    const { db, workDir } = setupKG();
    db.close();

    const gaps = findCoverageGaps([], workDir);
    expect(gaps).toEqual([]);
  });

  it("handles multiple test files mapping to same source", () => {
    const { db, workDir } = setupKG();
    saveTestMappings(db, [
      { sourceFile: "src/core.ts", testFiles: ["test/core.test.ts", "test/core-integration.test.ts"], confidence: "high" },
    ]);
    db.close();

    const gaps = findCoverageGaps(["src/core.ts"], workDir);
    expect(gaps).toEqual([]);
  });
});

describe("PRProcessorConfig tracker field", () => {
  it("PRProcessor class is importable with tracker config", async () => {
    const mod = await import("../../src/merge-daemon/pr-processor.js");
    expect(mod.PRProcessor).toBeDefined();
  });
});
