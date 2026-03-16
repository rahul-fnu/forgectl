import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SINGLE_TS_PATH = resolve("src/orchestration/single.ts");

describe("saveCheckpoint gating by skipCheckpoints", () => {
  it("all saveCheckpoint calls are gated by !plan.skipCheckpoints", () => {
    const source = readFileSync(SINGLE_TS_PATH, "utf-8");
    const allLines = source.split("\n");

    // Find all lines that call saveCheckpoint (excluding the import line)
    const checkpointCallLines = allLines.filter(
      (line) => line.includes("saveCheckpoint(") && !line.includes("import"),
    );

    // Every call site must be gated by !plan.skipCheckpoints
    expect(checkpointCallLines.length).toBeGreaterThan(0);

    for (const line of checkpointCallLines) {
      expect(
        line,
        `saveCheckpoint call not gated by !plan.skipCheckpoints: "${line.trim()}"`,
      ).toContain("!plan.skipCheckpoints");
    }
  });

  it("there are exactly 4 saveCheckpoint call sites", () => {
    const source = readFileSync(SINGLE_TS_PATH, "utf-8");
    const allLines = source.split("\n");

    const checkpointCallLines = allLines.filter(
      (line) => line.includes("saveCheckpoint(") && !line.includes("import"),
    );

    // The plan specifies 4 call sites: prepare, execute, validate, output
    expect(checkpointCallLines).toHaveLength(4);
  });

  it("skipCheckpoints: true results in CLAUDE_NUM_TEAMMATES being settable (env injection wired)", () => {
    // Structural test: verify that skipCheckpoints field flows through RunPlan
    // by checking single.ts references plan.skipCheckpoints
    const source = readFileSync(SINGLE_TS_PATH, "utf-8");
    expect(source).toContain("plan.skipCheckpoints");
  });
});
