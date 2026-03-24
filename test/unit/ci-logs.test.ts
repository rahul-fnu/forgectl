import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchCIErrorLog } from "../../src/github/ci-logs.js";

const headers = { Authorization: "token test" };

function mockFetchSequence(responses: Array<{ ok: boolean; json?: () => Promise<any>; text?: () => Promise<string> }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex++];
    return resp ?? { ok: false };
  });
}

describe("fetchCIErrorLog", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null when workflow runs API fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as any;
    const result = await fetchCIErrorLog("owner", "repo", "sha123", headers);
    expect(result).toBeNull();
  });

  it("returns null when no failed workflow found", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ workflow_runs: [{ id: 1, conclusion: "success" }] }),
    }) as any;
    const result = await fetchCIErrorLog("owner", "repo", "sha123", headers);
    expect(result).toBeNull();
  });

  it("returns null when jobs API fails", async () => {
    globalThis.fetch = mockFetchSequence([
      { ok: true, json: async () => ({ workflow_runs: [{ id: 1, conclusion: "failure" }] }) },
      { ok: false },
    ]) as any;
    const result = await fetchCIErrorLog("owner", "repo", "sha123", headers);
    expect(result).toBeNull();
  });

  it("returns null when no failed jobs", async () => {
    globalThis.fetch = mockFetchSequence([
      { ok: true, json: async () => ({ workflow_runs: [{ id: 1, conclusion: "failure" }] }) },
      { ok: true, json: async () => ({ jobs: [{ id: 10, name: "build", conclusion: "success" }] }) },
    ]) as any;
    const result = await fetchCIErrorLog("owner", "repo", "sha123", headers);
    expect(result).toBeNull();
  });

  it("returns null when logs API fails", async () => {
    globalThis.fetch = mockFetchSequence([
      { ok: true, json: async () => ({ workflow_runs: [{ id: 1, conclusion: "failure" }] }) },
      { ok: true, json: async () => ({ jobs: [{ id: 10, name: "build", conclusion: "failure" }] }) },
      { ok: false },
    ]) as any;
    const result = await fetchCIErrorLog("owner", "repo", "sha123", headers);
    expect(result).toBeNull();
  });

  it("extracts error lines with context window (2 before, 6 after)", async () => {
    const logLines = [
      "line 0: compiling...",
      "line 1: checking deps",
      "line 2: building module A",
      "line 3: error[E0308]: mismatched types",
      "line 4:   --> src/main.rs:10:5",
      "line 5:    |",
      "line 6: 10 |     let x: u32 = \"hello\";",
      "line 7:    |                   ^^^^^^^",
      "line 8:    = note: expected u32",
      "line 9: more info",
      "line 10: end",
    ];

    globalThis.fetch = mockFetchSequence([
      { ok: true, json: async () => ({ workflow_runs: [{ id: 1, conclusion: "failure" }] }) },
      { ok: true, json: async () => ({ jobs: [{ id: 10, name: "build", conclusion: "failure" }] }) },
      { ok: true, text: async () => logLines.join("\n") },
    ]) as any;

    const result = await fetchCIErrorLog("owner", "repo", "sha123", headers);
    expect(result).not.toBeNull();
    // Error is at index 3, context: 2 before (1,2) and 6 after (4..9)
    expect(result).toContain("line 1: checking deps");
    expect(result).toContain("line 2: building module A");
    expect(result).toContain("line 3: error[E0308]: mismatched types");
    expect(result).toContain("line 8:    = note: expected u32");
    // line 0 should NOT be included (more than 2 lines before)
    expect(result).not.toContain("line 0: compiling...");
  });

  it("strips ANSI escape codes from log output", async () => {
    const logLines = [
      "normal line 1",
      "normal line 2",
      "\x1b[31merror: cannot find module\x1b[0m",
      "  at index.ts:5",
      "  imported from app.ts",
    ];

    globalThis.fetch = mockFetchSequence([
      { ok: true, json: async () => ({ workflow_runs: [{ id: 1, conclusion: "failure" }] }) },
      { ok: true, json: async () => ({ jobs: [{ id: 10, name: "build", conclusion: "failure" }] }) },
      { ok: true, text: async () => logLines.join("\n") },
    ]) as any;

    const result = await fetchCIErrorLog("owner", "repo", "sha123", headers);
    expect(result).not.toBeNull();
    expect(result).not.toContain("\x1b[");
    expect(result).toContain("error: cannot find module");
  });

  it("strips timestamps from log output", async () => {
    const logLines = [
      "2024-01-15T10:30:00.123Z setup complete",
      "2024-01-15T10:30:01.456Z building...",
      "2024-01-15T10:30:02.789Z error: not found",
      "2024-01-15T10:30:03.000Z details here",
    ];

    globalThis.fetch = mockFetchSequence([
      { ok: true, json: async () => ({ workflow_runs: [{ id: 1, conclusion: "failure" }] }) },
      { ok: true, json: async () => ({ jobs: [{ id: 10, name: "build", conclusion: "failure" }] }) },
      { ok: true, text: async () => logLines.join("\n") },
    ]) as any;

    const result = await fetchCIErrorLog("owner", "repo", "sha123", headers);
    expect(result).not.toBeNull();
    expect(result).not.toContain("2024-01-15T10:30:");
    expect(result).toContain("error: not found");
  });

  it("deduplicates overlapping context windows", async () => {
    const logLines = [
      "preamble",
      "error: cannot find module A",
      "details for A",
      "error: cannot find module B",
      "details for B",
    ];

    globalThis.fetch = mockFetchSequence([
      { ok: true, json: async () => ({ workflow_runs: [{ id: 1, conclusion: "failure" }] }) },
      { ok: true, json: async () => ({ jobs: [{ id: 10, name: "build", conclusion: "failure" }] }) },
      { ok: true, text: async () => logLines.join("\n") },
    ]) as any;

    const result = await fetchCIErrorLog("owner", "repo", "sha123", headers);
    expect(result).not.toBeNull();
    const lines = result!.split("\n");
    // No duplicate lines
    const unique = new Set(lines);
    expect(lines.length).toBe(unique.size);
  });

  it("truncates output to 150 lines", async () => {
    // Generate a log with many errors, each producing context lines
    const logLines: string[] = [];
    for (let i = 0; i < 200; i++) {
      logLines.push(`error: failed to compile item ${i}`);
    }

    globalThis.fetch = mockFetchSequence([
      { ok: true, json: async () => ({ workflow_runs: [{ id: 1, conclusion: "failure" }] }) },
      { ok: true, json: async () => ({ jobs: [{ id: 10, name: "build", conclusion: "failure" }] }) },
      { ok: true, text: async () => logLines.join("\n") },
    ]) as any;

    const result = await fetchCIErrorLog("owner", "repo", "sha123", headers);
    expect(result).not.toBeNull();
    const outputLines = result!.split("\n");
    expect(outputLines.length).toBeLessThanOrEqual(150);
  });

  it("falls back to last 80 lines when no error pattern matches", async () => {
    const logLines: string[] = [];
    for (let i = 0; i < 100; i++) {
      logLines.push(`step ${i}: doing stuff`);
    }

    globalThis.fetch = mockFetchSequence([
      { ok: true, json: async () => ({ workflow_runs: [{ id: 1, conclusion: "failure" }] }) },
      { ok: true, json: async () => ({ jobs: [{ id: 10, name: "build", conclusion: "failure" }] }) },
      { ok: true, text: async () => logLines.join("\n") },
    ]) as any;

    const result = await fetchCIErrorLog("owner", "repo", "sha123", headers);
    expect(result).not.toBeNull();
    const outputLines = result!.split("\n");
    expect(outputLines.length).toBe(80);
    expect(outputLines[0]).toBe("step 20: doing stuff");
    expect(outputLines[79]).toBe("step 99: doing stuff");
  });

  it("matches various error patterns", async () => {
    const patterns = [
      "error[E0308]: mismatched types",
      "error: cannot find crate",
      "not found: module X",
      "expected u32 found String",
      "no method named 'foo' found",
      "mismatched types in assignment",
      "missing field `name` in initializer",
      "unresolved import `crate::foo`",
      "failed to compile",
    ];

    for (const pattern of patterns) {
      const logLines = ["before", "before2", pattern, "after"];
      globalThis.fetch = mockFetchSequence([
        { ok: true, json: async () => ({ workflow_runs: [{ id: 1, conclusion: "failure" }] }) },
        { ok: true, json: async () => ({ jobs: [{ id: 10, name: "build", conclusion: "failure" }] }) },
        { ok: true, text: async () => logLines.join("\n") },
      ]) as any;

      const result = await fetchCIErrorLog("owner", "repo", "sha123", headers);
      expect(result).toContain(pattern);
    }
  });

  it("returns null on network error (catch block)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error")) as any;
    const result = await fetchCIErrorLog("owner", "repo", "sha123", headers);
    expect(result).toBeNull();
  });

  it("handles empty workflow_runs gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ workflow_runs: [] }),
    }) as any;
    const result = await fetchCIErrorLog("owner", "repo", "sha123", headers);
    expect(result).toBeNull();
  });

  it("handles missing workflow_runs key", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as any;
    const result = await fetchCIErrorLog("owner", "repo", "sha123", headers);
    expect(result).toBeNull();
  });
});
