import { describe, it, expect } from "vitest";
import { findCoverageGaps } from "../../src/merge-daemon/pr-processor.js";

describe("findCoverageGaps", () => {
  it("exports findCoverageGaps function", () => {
    expect(typeof findCoverageGaps).toBe("function");
  });

  it("returns empty array when KG db does not exist", () => {
    const gaps = findCoverageGaps(["src/utils/helper.ts"], "/tmp/nonexistent-dir");
    expect(gaps).toEqual([]);
  });
});

describe("PRProcessorConfig tracker field", () => {
  it("PRProcessor class is importable with tracker config", async () => {
    const mod = await import("../../src/merge-daemon/pr-processor.js");
    expect(mod.PRProcessor).toBeDefined();
  });
});
