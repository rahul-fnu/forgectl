import { describe, it, expect, vi } from "vitest";

// Mock child_process.execFile before importing the module
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { analyzeChangeCoupling } from "../../src/kg/git-history.js";
import { execFile } from "node:child_process";

const mockExecFile = vi.mocked(execFile);

function mockGitLog(stdout: string) {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback?) => {
    // promisify wraps execFile, so it uses the callback form
    // But since we're mocking the promisified version indirectly,
    // we need to handle both patterns
    const cb = callback || (_opts as unknown as (err: Error | null, result: { stdout: string; stderr: string }) => void);
    if (typeof cb === "function") {
      cb(null, { stdout, stderr: "" } as never);
    }
    return {} as ReturnType<typeof execFile>;
  });
}

describe("analyzeChangeCoupling", () => {
  it("calculates coupling for files changing together", async () => {
    // 3 commits where a.ts and b.ts change together
    const gitOutput = [
      "abc1234567890123456789012345678901234567",
      "src/a.ts",
      "src/b.ts",
      "",
      "def1234567890123456789012345678901234567",
      "src/a.ts",
      "src/b.ts",
      "",
      "ghi1234567890123456789012345678901234567",
      "src/a.ts",
      "src/b.ts",
      "",
    ].join("\n");

    mockGitLog(gitOutput);

    const result = await analyzeChangeCoupling("/repo", {
      minCochanges: 3,
      minScore: 0.3,
    });

    expect(result).toHaveLength(1);
    expect(result[0].fileA).toBe("src/a.ts");
    expect(result[0].fileB).toBe("src/b.ts");
    expect(result[0].cochangeCount).toBe(3);
    expect(result[0].couplingScore).toBe(1.0);
  });

  it("filters out pairs below minimum co-change count", async () => {
    const gitOutput = [
      "abc1234567890123456789012345678901234567",
      "src/a.ts",
      "src/b.ts",
      "",
      "def1234567890123456789012345678901234567",
      "src/a.ts",
      "src/b.ts",
      "",
    ].join("\n");

    mockGitLog(gitOutput);

    const result = await analyzeChangeCoupling("/repo", {
      minCochanges: 3,
      minScore: 0.0,
    });

    expect(result).toHaveLength(0);
  });

  it("filters out pairs below minimum coupling score", async () => {
    // a.ts changes in 10 commits, b.ts in 10 commits, together only 3 times
    const lines: string[] = [];
    for (let i = 0; i < 3; i++) {
      lines.push(`${"a".repeat(40)}`);
      lines.push("src/a.ts");
      lines.push("src/b.ts");
      lines.push("");
    }
    for (let i = 0; i < 7; i++) {
      lines.push(`${"b".repeat(40)}`);
      lines.push("src/a.ts");
      lines.push("");
    }
    for (let i = 0; i < 7; i++) {
      lines.push(`${"c".repeat(40)}`);
      lines.push("src/b.ts");
      lines.push("");
    }

    mockGitLog(lines.join("\n"));

    const result = await analyzeChangeCoupling("/repo", {
      minCochanges: 1,
      minScore: 0.5,
    });

    // 3 co-changes / 10 min commits = 0.3, below 0.5 threshold
    expect(result).toHaveLength(0);
  });

  it("only counts TypeScript files", async () => {
    const gitOutput = [
      "abc1234567890123456789012345678901234567",
      "src/a.ts",
      "README.md",
      "package.json",
      "",
    ].join("\n");

    mockGitLog(gitOutput);

    const result = await analyzeChangeCoupling("/repo", {
      minCochanges: 1,
      minScore: 0.0,
    });

    // README.md and package.json are not TS, so no pairs
    expect(result).toHaveLength(0);
  });

  it("sorts results by coupling score descending", async () => {
    const lines: string[] = [];
    // a+b change together 5 times
    for (let i = 0; i < 5; i++) {
      lines.push(`${"a".repeat(40)}`);
      lines.push("src/a.ts");
      lines.push("src/b.ts");
      lines.push("");
    }
    // a+c change together 3 times, but a has 5 commits total so score = 3/5 = 0.6
    for (let i = 0; i < 3; i++) {
      lines.push(`${"b".repeat(40)}`);
      lines.push("src/a.ts");
      lines.push("src/c.ts");
      lines.push("");
    }

    mockGitLog(lines.join("\n"));

    const result = await analyzeChangeCoupling("/repo", {
      minCochanges: 3,
      minScore: 0.3,
    });

    expect(result.length).toBeGreaterThanOrEqual(1);
    // Should be sorted by score descending
    if (result.length > 1) {
      expect(result[0].couplingScore).toBeGreaterThanOrEqual(result[1].couplingScore);
    }
  });
});
