import { describe, expect, it } from "vitest";
import { sanitizeMergeOutput } from "../../src/merge-daemon/git-operations.js";

describe("merge-daemon git-operations", () => {
  describe("sanitizeMergeOutput", () => {
    it("returns cleaned content for valid input", () => {
      const result = sanitizeMergeOutput("fn main() {}", "main.rs");
      expect(result).toBe("fn main() {}\n");
    });

    it("returns null for empty input", () => {
      expect(sanitizeMergeOutput("", "file.ts")).toBeNull();
      expect(sanitizeMergeOutput("   ", "file.ts")).toBeNull();
    });

    it("rejects error messages", () => {
      expect(sanitizeMergeOutput("error: something went wrong", "file.ts")).toBeNull();
      expect(sanitizeMergeOutput("Error: Reached max turns", "file.ts")).toBeNull();
    });

    it("rejects conversational output", () => {
      expect(sanitizeMergeOutput("I merged the files", "file.ts")).toBeNull();
      expect(sanitizeMergeOutput("Here is the merged file", "file.ts")).toBeNull();
      expect(sanitizeMergeOutput("The merged content", "file.ts")).toBeNull();
    });

    it("strips markdown code fences", () => {
      const input = "```typescript\nconst x = 1;\n```";
      const result = sanitizeMergeOutput(input, "file.ts");
      expect(result).toBe("const x = 1;\n");
    });

    it("rejects invalid TOML", () => {
      expect(sanitizeMergeOutput("just text", "config.toml")).toBeNull();
    });

    it("rejects invalid JSON", () => {
      expect(sanitizeMergeOutput("not json", "data.json")).toBeNull();
    });

    it("accepts valid JSON", () => {
      const result = sanitizeMergeOutput('{"key": "value"}', "data.json");
      expect(result).toBe('{"key": "value"}\n');
    });

    it("rejects invalid Rust files", () => {
      expect(sanitizeMergeOutput("just text no rust", "lib.rs")).toBeNull();
    });

    it("accepts valid Rust files", () => {
      const result = sanitizeMergeOutput("fn main() {}", "lib.rs");
      expect(result).toBe("fn main() {}\n");
    });

    it("strips code fences and returns content", () => {
      // Fences at line start get stripped; remaining content is returned
      const input = "```ts\nconst x = 1;\n```";
      const result = sanitizeMergeOutput(input, "file.ts");
      expect(result).toBe("const x = 1;\n");
    });
  });
});
