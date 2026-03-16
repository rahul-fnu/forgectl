import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectContentProblems } from "../../src/output/staged-file-validator.js";

// ──────────────────────────────────────────────────────
// Unit tests for detectContentProblems (pure function)
// ──────────────────────────────────────────────────────

describe("detectContentProblems", () => {
  // --- Valid files should pass ---

  it("returns null for valid TypeScript file", () => {
    expect(detectContentProblems("export function foo() {}", "src/index.ts")).toBeNull();
  });

  it("returns null for valid JavaScript file", () => {
    expect(detectContentProblems("const x = 1;", "app.js")).toBeNull();
  });

  it("returns null for valid Python file", () => {
    expect(detectContentProblems("def main():\n  pass", "main.py")).toBeNull();
  });

  it("returns null for valid Go file", () => {
    expect(detectContentProblems("package main\n\nfunc main() {}", "main.go")).toBeNull();
  });

  it("returns null for valid YAML file", () => {
    expect(detectContentProblems("name: test\nversion: 1.0", "config.yaml")).toBeNull();
  });

  it("returns null for file with no extension", () => {
    expect(detectContentProblems("some content", "Makefile")).toBeNull();
  });

  // --- Agent error messages ---

  it("detects Error: at line start near beginning of file", () => {
    const result = detectContentProblems("Error: something went wrong", "file.ts");
    expect(result).toContain("agent error message");
  });

  it("detects Error: Reached max turns as first line", () => {
    const result = detectContentProblems("Error: Reached max turns", "file.ts");
    expect(result).toBeTruthy();
  });

  it("detects Error: on second line within 200 chars", () => {
    const result = detectContentProblems("header\nError: compilation failed", "file.ts");
    expect(result).toContain("agent error message");
  });

  it("allows Error: deep in file (beyond 200 chars)", () => {
    const content = "a".repeat(300) + "\nError: this is fine deep in the file";
    expect(detectContentProblems(content, "file.ts")).toBeNull();
  });

  it("detects Error: on a new line within 200 chars", () => {
    // Error: must be at start of a line (^Error: with /m flag)
    // and indexOf("Error:") must be < 200
    const content = "a".repeat(190) + "\nError: boundary";
    expect(detectContentProblems(content, "file.ts")).toContain("agent error message");
  });

  it("allows Error: on a new line beyond 200 chars", () => {
    // Error: at line start but indexOf > 200
    const content = "a".repeat(210) + "\nError: out of range";
    expect(detectContentProblems(content, "file.ts")).toBeNull();
  });

  it("does NOT match Error: mid-line (regex requires ^)", () => {
    // Error: exists but not at start of line
    const content = "some prefix Error: not at start of line";
    expect(detectContentProblems(content, "file.ts")).toBeNull();
  });

  it("detects Error: with multiline content (regex ^Error: tests start of any line)", () => {
    const content = "// valid code\nError: agent crashed\nmore content";
    expect(detectContentProblems(content, "file.ts")).toContain("agent error message");
  });

  // --- Markdown code fences ---

  it("detects triple backtick code fence in .rs file", () => {
    const result = detectContentProblems("```rust\nfn main() {}\n```", "main.rs");
    expect(result).toContain("markdown code fences");
  });

  it("detects triple backtick code fence in .toml file", () => {
    const result = detectContentProblems("```toml\n[package]\nname = \"x\"\n```", "Cargo.toml");
    expect(result).toContain("markdown code fences");
  });

  it("detects triple backtick code fence in .ts file", () => {
    const result = detectContentProblems("```typescript\nconst x = 1;\n```", "index.ts");
    expect(result).toContain("markdown code fences");
  });

  it("detects code fence in middle of file", () => {
    const content = "fn main() {\n```\nsome junk\n```\n}";
    // .rs needs fn/mod/use/struct, this has fn, so rust check passes but fence detected
    const result = detectContentProblems(content, "main.rs");
    expect(result).toContain("markdown code fences");
  });

  it("allows code fences in .md file", () => {
    expect(detectContentProblems("```rust\nfn main() {}\n```", "README.md")).toBeNull();
  });

  it("allows code fences in .mdx file", () => {
    expect(detectContentProblems("```js\nconst x = 1;\n```", "doc.mdx")).toBeNull();
  });

  it("allows code fences in .MD file (case insensitive)", () => {
    // Extension extraction is lowercase
    expect(detectContentProblems("```code\n```", "NOTES.MD")).toBeNull();
  });

  // --- Git conflict markers ---

  it("detects <<<<<<< conflict marker", () => {
    const content = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch";
    const result = detectContentProblems(content, "file.ts");
    expect(result).toContain("conflict markers");
  });

  it("detects ======= conflict marker alone", () => {
    const content = "some code\n=======\nmore code";
    const result = detectContentProblems(content, "file.ts");
    expect(result).toContain("conflict markers");
  });

  it("detects >>>>>>> conflict marker alone", () => {
    const content = "some code\n>>>>>>> feature-branch\nmore code";
    const result = detectContentProblems(content, "file.ts");
    expect(result).toContain("conflict markers");
  });

  it("allows fewer than 7 consecutive markers", () => {
    // 6 equals signs is not a conflict marker
    const content = "======\nnot a conflict";
    expect(detectContentProblems(content, "file.ts")).toBeNull();
  });

  it("detects conflict markers in middle of file", () => {
    const content = "fn main() {\n<<<<<<< HEAD\n  let x = 1;\n=======\n  let x = 2;\n>>>>>>> fix\n}";
    // Has fn so Rust check passes, but conflict markers detected
    const result = detectContentProblems(content, "main.rs");
    expect(result).toContain("conflict markers");
  });

  // --- TOML file sanity ---

  it("detects TOML file without section header (no [)", () => {
    const result = detectContentProblems("name = \"foo\"\nversion = \"1.0\"", "Cargo.toml");
    expect(result).toContain("TOML");
    expect(result).toContain("section headers");
  });

  it("allows valid TOML file with [section]", () => {
    expect(detectContentProblems("[package]\nname = \"foo\"", "Cargo.toml")).toBeNull();
  });

  it("allows TOML with inline table (has [)", () => {
    expect(detectContentProblems("dep = { version = \"1.0\" } # contains [", "config.toml")).toBeNull();
  });

  it("applies TOML check only to .toml extension", () => {
    // Same content in a .txt file should be fine
    expect(detectContentProblems("name = \"foo\"", "notes.txt")).toBeNull();
  });

  // --- JSON file sanity ---

  it("detects JSON file not starting with { or [", () => {
    const result = detectContentProblems("not json content", "data.json");
    expect(result).toContain("JSON");
  });

  it("allows JSON starting with {", () => {
    expect(detectContentProblems('{ "key": "value" }', "data.json")).toBeNull();
  });

  it("allows JSON starting with [", () => {
    expect(detectContentProblems('[1, 2, 3]', "data.json")).toBeNull();
  });

  it("allows JSON with leading whitespace before {", () => {
    expect(detectContentProblems('  \n  { "key": 1 }', "data.json")).toBeNull();
  });

  it("allows JSON with leading whitespace before [", () => {
    expect(detectContentProblems('\n  [1, 2]', "data.json")).toBeNull();
  });

  it("applies JSON check only to .json extension", () => {
    expect(detectContentProblems("not json content", "data.txt")).toBeNull();
  });

  // --- Rust file sanity ---

  it("detects Rust file missing all keywords", () => {
    const result = detectContentProblems("Hello world this is not rust", "lib.rs");
    expect(result).toContain("Rust file");
    expect(result).toContain("fn/mod/use/struct");
  });

  it("allows Rust file with fn keyword", () => {
    expect(detectContentProblems("fn main() {}", "main.rs")).toBeNull();
  });

  it("allows Rust file with mod keyword", () => {
    expect(detectContentProblems("mod tests;", "lib.rs")).toBeNull();
  });

  it("allows Rust file with use keyword", () => {
    expect(detectContentProblems("use std::io;", "lib.rs")).toBeNull();
  });

  it("allows Rust file with struct keyword", () => {
    expect(detectContentProblems("struct Foo { x: i32 }", "types.rs")).toBeNull();
  });

  it("applies Rust check only to .rs extension", () => {
    expect(detectContentProblems("hello world", "main.py")).toBeNull();
  });

  // --- Priority / order of checks ---

  it("Error: check takes priority over TOML check", () => {
    // This is TOML but starts with Error:
    const result = detectContentProblems("Error: bad config", "Cargo.toml");
    expect(result).toContain("error");
  });

  it("Error: check takes priority over JSON check", () => {
    const result = detectContentProblems("Error: parse failed", "data.json");
    expect(result).toContain("error");
  });

  it("code fence check takes priority over Rust keyword check", () => {
    // Has no Rust keywords, but code fence is detected first
    const result = detectContentProblems("```\nhello\n```", "main.rs");
    expect(result).toContain("markdown code fences");
  });

  // --- Edge cases ---

  it("handles empty string content", () => {
    // Empty content shouldn't match any regex
    expect(detectContentProblems("", "file.ts")).toBeNull();
  });

  it("handles file with only whitespace", () => {
    expect(detectContentProblems("   \n   \n", "file.ts")).toBeNull();
  });

  it("handles path-like filename correctly extracts extension", () => {
    expect(detectContentProblems("[package]", "path/to/Cargo.toml")).toBeNull();
  });

  it("handles filename with multiple dots", () => {
    expect(detectContentProblems("[deps]", "my.project.config.toml")).toBeNull();
  });
});

// ──────────────────────────────────────────────────────
// Integration tests for validateStagedFiles (mocked container)
// ──────────────────────────────────────────────────────

vi.mock("../../src/container/runner.js", () => ({
  execInContainer: vi.fn(),
}));

const { validateStagedFiles } = await import("../../src/output/staged-file-validator.js");
const { execInContainer } = await import("../../src/container/runner.js");

describe("validateStagedFiles", () => {
  const mockContainer = {} as any;
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no staged files", async () => {
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });

    const result = await validateStagedFiles(mockContainer, mockLogger as any);
    expect(result).toEqual([]);
  });

  it("skips .gitignore file", async () => {
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: ".gitignore\n",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });

    const result = await validateStagedFiles(mockContainer, mockLogger as any);
    expect(result).toEqual([]);
    // Only the git diff call, no cat call for .gitignore
    expect(execInContainer).toHaveBeenCalledTimes(1);
  });

  it("leaves valid files staged", async () => {
    // git diff --cached --name-only
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "src/main.ts\n",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    // cat src/main.ts
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "export function hello() { return 'world'; }",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });

    const result = await validateStagedFiles(mockContainer, mockLogger as any);
    expect(result).toEqual([]);
    // No git reset call — file is valid
    expect(execInContainer).toHaveBeenCalledTimes(2);
  });

  it("unstages file with agent error message", async () => {
    // git diff --cached --name-only
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "src/broken.ts\n",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    // cat src/broken.ts
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "Error: Reached max turns. Unable to complete the task.",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    // git reset HEAD src/broken.ts
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });

    const result = await validateStagedFiles(mockContainer, mockLogger as any);
    expect(result).toEqual(["src/broken.ts"]);
    expect(execInContainer).toHaveBeenCalledTimes(3);
    // Verify the reset command
    expect(vi.mocked(execInContainer).mock.calls[2][1]).toEqual([
      "git", "reset", "HEAD", "src/broken.ts",
    ]);
  });

  it("unstages file with markdown code fences", async () => {
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "Cargo.toml\n",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "```toml\n[package]\nname = \"x\"\n```",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });

    const result = await validateStagedFiles(mockContainer, mockLogger as any);
    expect(result).toEqual(["Cargo.toml"]);
  });

  it("unstages file with conflict markers", async () => {
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "src/lib.rs\n",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "use std::io;\nfn main() {\n<<<<<<< HEAD\n  let x = 1;\n=======\n  let x = 2;\n>>>>>>> fix\n}",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });

    const result = await validateStagedFiles(mockContainer, mockLogger as any);
    expect(result).toEqual(["src/lib.rs"]);
  });

  it("handles mix of valid and invalid files", async () => {
    // git diff --cached --name-only returns 3 files
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "src/good.ts\nsrc/bad.rs\nREADME.md\n",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    // cat src/good.ts — valid
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "const x = 1;",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    // cat src/bad.rs — agent error
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "Error: Reached max turns",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    // git reset HEAD src/bad.rs
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    // cat README.md — valid (code fences allowed in markdown)
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "```js\nconst x = 1;\n```",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });

    const result = await validateStagedFiles(mockContainer, mockLogger as any);
    expect(result).toEqual(["src/bad.rs"]);
  });

  it("skips deleted files (cat throws)", async () => {
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "src/deleted.ts\n",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    // cat throws for deleted file
    vi.mocked(execInContainer).mockRejectedValueOnce(new Error("No such file"));

    const result = await validateStagedFiles(mockContainer, mockLogger as any);
    expect(result).toEqual([]);
  });

  it("skips empty file content", async () => {
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "src/empty.ts\n",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });

    const result = await validateStagedFiles(mockContainer, mockLogger as any);
    expect(result).toEqual([]);
  });

  it("handles git reset failure gracefully", async () => {
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "src/bad.ts\n",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "Error: agent crashed",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    // git reset fails
    vi.mocked(execInContainer).mockRejectedValueOnce(new Error("git reset failed"));

    const result = await validateStagedFiles(mockContainer, mockLogger as any);
    // File not added to unstaged list since reset failed
    expect(result).toEqual([]);
    // But warning was logged
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "output",
      expect.stringContaining("Failed to unstage"),
    );
  });

  it("logs warning with count of unstaged files", async () => {
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "a.rs\nb.rs\n",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    // Both files are bad (no Rust keywords)
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "garbage content no rust keywords",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "more garbage no keywords",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });

    const result = await validateStagedFiles(mockContainer, mockLogger as any);
    expect(result).toHaveLength(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "output",
      expect.stringContaining("Unstaged 2 invalid file(s)"),
    );
  });

  it("logs individual warning per unstaged file", async () => {
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "broken.rs\n",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "Error: agent failed",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });
    vi.mocked(execInContainer).mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    });

    await validateStagedFiles(mockContainer, mockLogger as any);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "output",
      expect.stringContaining("Unstaging broken.rs"),
    );
  });
});
