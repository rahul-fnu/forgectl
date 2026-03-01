import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listFilesRecursive, formatBytes } from "../../src/output/files.js";

describe("listFilesRecursive", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array for empty directory", () => {
    expect(listFilesRecursive(tmpDir)).toEqual([]);
  });

  it("returns file names in flat directory", () => {
    writeFileSync(join(tmpDir, "a.txt"), "");
    writeFileSync(join(tmpDir, "b.txt"), "");
    const files = listFilesRecursive(tmpDir);
    expect(files).toContain("a.txt");
    expect(files).toContain("b.txt");
    expect(files).toHaveLength(2);
  });

  it("returns nested files with path prefix", () => {
    mkdirSync(join(tmpDir, "subdir"));
    writeFileSync(join(tmpDir, "subdir", "nested.txt"), "");
    writeFileSync(join(tmpDir, "root.txt"), "");
    const files = listFilesRecursive(tmpDir);
    expect(files).toContain("root.txt");
    expect(files).toContain("subdir/nested.txt");
  });

  it("handles deeply nested directories", () => {
    mkdirSync(join(tmpDir, "a", "b", "c"), { recursive: true });
    writeFileSync(join(tmpDir, "a", "b", "c", "deep.txt"), "");
    const files = listFilesRecursive(tmpDir);
    expect(files).toContain("a/b/c/deep.txt");
  });

  it("returns empty array for nonexistent directory", () => {
    expect(listFilesRecursive("/nonexistent/path/abc")).toEqual([]);
  });

  it("does not include directory entries, only files", () => {
    mkdirSync(join(tmpDir, "emptydir"));
    writeFileSync(join(tmpDir, "file.txt"), "");
    const files = listFilesRecursive(tmpDir);
    expect(files).not.toContain("emptydir");
    expect(files).toContain("file.txt");
  });
});

describe("formatBytes", () => {
  it("formats bytes under 1KB", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(1023)).toBe("1023B");
  });

  it("formats bytes as KB", () => {
    expect(formatBytes(1024)).toBe("1.0KB");
    expect(formatBytes(2048)).toBe("2.0KB");
    expect(formatBytes(1536)).toBe("1.5KB");
  });

  it("formats bytes as MB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0MB");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5MB");
  });
});
