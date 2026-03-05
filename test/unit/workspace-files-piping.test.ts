import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareFilesWorkspace } from "../../src/container/workspace.js";

describe("prepareFilesWorkspace", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("preserves nested structure for staged upstream directories and keeps binary bytes intact", () => {
    const stagedRoot = mkdtempSync(join(tmpdir(), "forgectl-stage-"));
    tempDirs.push(stagedRoot);

    const aDir = join(stagedRoot, "upstream", "research-a", "docs");
    const bDir = join(stagedRoot, "upstream", "research-b", "docs");
    mkdirSync(aDir, { recursive: true });
    mkdirSync(bDir, { recursive: true });

    writeFileSync(join(aDir, "spec.md"), "# spec A\n");
    writeFileSync(join(aDir, "schema.json"), "{\"type\":\"object\"}\n");
    writeFileSync(join(bDir, "spec.md"), "# spec B\n");
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4]);
    writeFileSync(join(bDir, "diagram.png"), pngBytes);

    const { inputDir, outputDir } = prepareFilesWorkspace([stagedRoot]);
    tempDirs.push(join(inputDir, "..")); // remove full temp workspace root

    const aSpec = join(inputDir, "upstream", "research-a", "docs", "spec.md");
    const bSpec = join(inputDir, "upstream", "research-b", "docs", "spec.md");
    const bPng = join(inputDir, "upstream", "research-b", "docs", "diagram.png");

    expect(existsSync(aSpec)).toBe(true);
    expect(existsSync(bSpec)).toBe(true);
    expect(readFileSync(aSpec, "utf-8")).toContain("spec A");
    expect(readFileSync(bSpec, "utf-8")).toContain("spec B");
    expect(readFileSync(bPng)).toEqual(pngBytes);
    expect(existsSync(outputDir)).toBe(true);
  });

  it("still copies individual files by basename for direct CLI inputs", () => {
    const inputRoot = mkdtempSync(join(tmpdir(), "forgectl-stage-file-"));
    tempDirs.push(inputRoot);
    const filePath = join(inputRoot, "notes.md");
    writeFileSync(filePath, "hello\n");

    const { inputDir } = prepareFilesWorkspace([filePath]);
    tempDirs.push(join(inputDir, ".."));

    expect(readFileSync(join(inputDir, "notes.md"), "utf-8")).toBe("hello\n");
  });
});
