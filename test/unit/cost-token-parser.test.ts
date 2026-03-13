import { describe, it, expect } from "vitest";
import {
  parseClaudeCodeTokens,
  parseCodexTokens,
  parseTokenUsage,
} from "../../src/agent/token-parser.js";

describe("agent/token-parser", () => {
  describe("parseClaudeCodeTokens", () => {
    it("returns null for empty input", () => {
      expect(parseClaudeCodeTokens("")).toBeNull();
    });

    it("parses 'input=N, output=N' format", () => {
      const result = parseClaudeCodeTokens("Token usage: input=1234, output=567");
      expect(result).toEqual({ inputTokens: 1234, outputTokens: 567 });
    });

    it("parses 'input: N, output: N' format", () => {
      const result = parseClaudeCodeTokens("Token usage: input: 1234, output: 567");
      expect(result).toEqual({ inputTokens: 1234, outputTokens: 567 });
    });

    it("parses 'Input tokens: N' and 'Output tokens: N' format", () => {
      const stderr = "Some output\nInput tokens: 5000\nOutput tokens: 2000\nDone";
      const result = parseClaudeCodeTokens(stderr);
      expect(result).toEqual({ inputTokens: 5000, outputTokens: 2000 });
    });

    it("parses numbers with commas", () => {
      const result = parseClaudeCodeTokens("input=1,234, output=5,678");
      expect(result).toEqual({ inputTokens: 1234, outputTokens: 5678 });
    });

    it("parses 'Total input tokens: N | Total output tokens: N' format", () => {
      const stderr = "Total input tokens: 10,000 | Total output tokens: 3,500";
      const result = parseClaudeCodeTokens(stderr);
      expect(result).toEqual({ inputTokens: 10000, outputTokens: 3500 });
    });

    it("returns null when no token info found", () => {
      const result = parseClaudeCodeTokens("Just some random stderr output");
      expect(result).toBeNull();
    });
  });

  describe("parseCodexTokens", () => {
    it("returns null for empty input", () => {
      expect(parseCodexTokens("")).toBeNull();
    });

    it("parses OpenAI-style usage object", () => {
      const output = JSON.stringify({
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      });
      const result = parseCodexTokens(output);
      expect(result).toEqual({ inputTokens: 1000, outputTokens: 500 });
    });

    it("parses direct input_tokens/output_tokens fields", () => {
      const output = JSON.stringify({ input_tokens: 2000, output_tokens: 800 });
      const result = parseCodexTokens(output);
      expect(result).toEqual({ inputTokens: 2000, outputTokens: 800 });
    });

    it("extracts JSON from surrounding text", () => {
      const output = `Some text before\n${JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\nSome text after`;
      const result = parseCodexTokens(output);
      expect(result).toEqual({ inputTokens: 100, outputTokens: 50 });
    });

    it("returns null when no valid JSON found", () => {
      const result = parseCodexTokens("no json here");
      expect(result).toBeNull();
    });

    it("returns null when JSON has no token fields", () => {
      const output = JSON.stringify({ result: "success" });
      const result = parseCodexTokens(output);
      expect(result).toBeNull();
    });
  });

  describe("parseTokenUsage", () => {
    it("dispatches to claude-code parser for claude-code agent", () => {
      const result = parseTokenUsage("claude-code", "", "input=100, output=50");
      expect(result).toEqual({ inputTokens: 100, outputTokens: 50 });
    });

    it("dispatches to codex parser for codex agent", () => {
      const output = JSON.stringify({ usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 } });
      const result = parseTokenUsage("codex", output, "");
      expect(result).toEqual({ inputTokens: 200, outputTokens: 100 });
    });

    it("codex falls back to stderr if stdout has no tokens", () => {
      const stderrOutput = JSON.stringify({ input_tokens: 300, output_tokens: 150 });
      const result = parseTokenUsage("codex", "no json here", stderrOutput);
      expect(result).toEqual({ inputTokens: 300, outputTokens: 150 });
    });

    it("returns null for unknown agent with no token data", () => {
      const result = parseTokenUsage("unknown-agent", "hello", "world");
      expect(result).toBeNull();
    });
  });
});
