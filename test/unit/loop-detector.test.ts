import { describe, it, expect } from "vitest";
import { LoopDetector, describeLoopPattern, type LoopPattern } from "../../src/agent/loop-detector.js";

describe("LoopDetector", () => {
  describe("repeated file writes", () => {
    it("does not trigger below threshold", () => {
      const d = new LoopDetector();
      expect(d.recordFileWrite("a.ts")).toBeNull();
      expect(d.recordFileWrite("a.ts")).toBeNull();
      expect(d.recordFileWrite("b.ts")).toBeNull();
    });

    it("triggers at 4 writes to <=2 files", () => {
      const d = new LoopDetector();
      d.recordFileWrite("a.ts");
      d.recordFileWrite("a.ts");
      d.recordFileWrite("b.ts");
      const result = d.recordFileWrite("b.ts");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("repeated_file_writes");
      if (result!.kind === "repeated_file_writes") {
        expect(result!.writeCount).toBe(4);
        expect(result!.files).toContain("a.ts");
        expect(result!.files).toContain("b.ts");
      }
    });

    it("does not trigger when writes spread across many files", () => {
      const d = new LoopDetector();
      d.recordFileWrite("a.ts");
      d.recordFileWrite("b.ts");
      d.recordFileWrite("c.ts");
      // 4 total writes, but each file only written once except d.ts
      const result = d.recordFileWrite("d.ts");
      expect(result).toBeNull();
    });

    it("triggers with single file written 4+ times", () => {
      const d = new LoopDetector();
      d.recordFileWrite("a.ts");
      d.recordFileWrite("a.ts");
      d.recordFileWrite("a.ts");
      const result = d.recordFileWrite("a.ts");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("repeated_file_writes");
    });

    it("respects custom thresholds", () => {
      const d = new LoopDetector({ maxFileWrites: 2, maxUniqueFiles: 1 });
      d.recordFileWrite("a.ts");
      const result = d.recordFileWrite("a.ts");
      expect(result).not.toBeNull();
    });
  });

  describe("repeated validation errors", () => {
    it("does not trigger below threshold", () => {
      const d = new LoopDetector();
      expect(d.recordValidationError("error: foo")).toBeNull();
      expect(d.recordValidationError("error: foo")).toBeNull();
    });

    it("triggers at 3 identical errors", () => {
      const d = new LoopDetector();
      d.recordValidationError("error: foo");
      d.recordValidationError("error: foo");
      const result = d.recordValidationError("error: foo");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("repeated_validation_error");
      if (result!.kind === "repeated_validation_error") {
        expect(result!.count).toBe(3);
      }
    });

    it("normalizes whitespace", () => {
      const d = new LoopDetector();
      d.recordValidationError("error:  foo\n  bar");
      d.recordValidationError("error: foo bar");
      const result = d.recordValidationError("error:   foo    bar");
      expect(result).not.toBeNull();
    });

    it("treats different errors independently", () => {
      const d = new LoopDetector();
      d.recordValidationError("error: foo");
      d.recordValidationError("error: bar");
      d.recordValidationError("error: foo");
      expect(d.recordValidationError("error: bar")).toBeNull();
      expect(d.recordValidationError("error: foo")).not.toBeNull();
    });

    it("respects custom threshold", () => {
      const d = new LoopDetector({ maxRepeatedErrors: 2 });
      d.recordValidationError("error: foo");
      const result = d.recordValidationError("error: foo");
      expect(result).not.toBeNull();
    });
  });

  describe("repeated tool calls", () => {
    it("does not trigger below threshold", () => {
      const d = new LoopDetector();
      expect(d.recordToolCall("write", { path: "a.ts" })).toBeNull();
      expect(d.recordToolCall("write", { path: "a.ts" })).toBeNull();
    });

    it("triggers at 3 identical calls", () => {
      const d = new LoopDetector();
      d.recordToolCall("write", { path: "a.ts", content: "x" });
      d.recordToolCall("write", { path: "a.ts", content: "x" });
      const result = d.recordToolCall("write", { path: "a.ts", content: "x" });
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("repeated_tool_call");
      if (result!.kind === "repeated_tool_call") {
        expect(result!.tool).toBe("write");
        expect(result!.count).toBe(3);
      }
    });

    it("treats different params as different calls", () => {
      const d = new LoopDetector();
      d.recordToolCall("write", { path: "a.ts" });
      d.recordToolCall("write", { path: "b.ts" });
      d.recordToolCall("write", { path: "a.ts" });
      expect(d.recordToolCall("write", { path: "b.ts" })).toBeNull();
    });
  });

  describe("reset", () => {
    it("clears all tracked state", () => {
      const d = new LoopDetector();
      d.recordFileWrite("a.ts");
      d.recordFileWrite("a.ts");
      d.recordValidationError("err");
      d.recordValidationError("err");
      d.recordToolCall("write", { path: "a.ts" });
      d.recordToolCall("write", { path: "a.ts" });

      d.reset();

      // After reset, none should trigger
      expect(d.recordFileWrite("a.ts")).toBeNull();
      expect(d.recordValidationError("err")).toBeNull();
      expect(d.recordToolCall("write", { path: "a.ts" })).toBeNull();
    });
  });

  describe("describeLoopPattern", () => {
    it("describes repeated file writes", () => {
      const pattern: LoopPattern = { kind: "repeated_file_writes", files: ["a.ts"], writeCount: 5 };
      const desc = describeLoopPattern(pattern);
      expect(desc).toContain("a.ts");
      expect(desc).toContain("5 writes");
    });

    it("describes repeated validation error", () => {
      const pattern: LoopPattern = { kind: "repeated_validation_error", error: "type error", count: 3 };
      const desc = describeLoopPattern(pattern);
      expect(desc).toContain("type error");
      expect(desc).toContain("3 times");
    });

    it("describes repeated tool call", () => {
      const pattern: LoopPattern = { kind: "repeated_tool_call", tool: "write", params: "{}", count: 4 };
      const desc = describeLoopPattern(pattern);
      expect(desc).toContain("write");
      expect(desc).toContain("4 times");
    });
  });
});
