import { describe, it, expect } from "vitest";
import {
  createLoopDetectorState,
  recordFileWrite,
  recordValidationError,
  recordToolCall,
} from "../../src/agent/loop-detector.js";

describe("agent/loop-detector", () => {
  describe("recordFileWrite", () => {
    it("does not trigger below threshold", () => {
      const state = createLoopDetectorState();
      expect(recordFileWrite(state, "src/index.ts")).toBeNull();
      expect(recordFileWrite(state, "src/index.ts")).toBeNull();
      expect(recordFileWrite(state, "src/index.ts")).toBeNull();
    });

    it("triggers on 4+ writes to 1 file", () => {
      const state = createLoopDetectorState();
      recordFileWrite(state, "src/index.ts");
      recordFileWrite(state, "src/index.ts");
      recordFileWrite(state, "src/index.ts");
      const result = recordFileWrite(state, "src/index.ts");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("repeated_file_writes");
      expect(result!.detail).toContain("4 writes");
      expect(result!.detail).toContain("1 file(s)");
    });

    it("triggers on 4+ writes to 2 files", () => {
      const state = createLoopDetectorState();
      recordFileWrite(state, "src/a.ts");
      recordFileWrite(state, "src/b.ts");
      recordFileWrite(state, "src/a.ts");
      const result = recordFileWrite(state, "src/b.ts");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("repeated_file_writes");
      expect(result!.detail).toContain("2 file(s)");
    });

    it("does not trigger when writes spread across 3+ files", () => {
      const state = createLoopDetectorState();
      recordFileWrite(state, "src/a.ts");
      recordFileWrite(state, "src/b.ts");
      recordFileWrite(state, "src/c.ts");
      const result = recordFileWrite(state, "src/a.ts");
      expect(result).toBeNull();
    });
  });

  describe("recordValidationError", () => {
    it("does not trigger below 3 repetitions", () => {
      const state = createLoopDetectorState();
      expect(recordValidationError(state, "Error: cannot find module")).toBeNull();
      expect(recordValidationError(state, "Error: cannot find module")).toBeNull();
    });

    it("triggers on 3 consecutive identical errors", () => {
      const state = createLoopDetectorState();
      recordValidationError(state, "Error: cannot find module");
      recordValidationError(state, "Error: cannot find module");
      const result = recordValidationError(state, "Error: cannot find module");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("repeated_validation_error");
      expect(result!.detail).toContain("3 times");
    });

    it("does not trigger when errors differ", () => {
      const state = createLoopDetectorState();
      recordValidationError(state, "Error: cannot find module A");
      recordValidationError(state, "Error: cannot find module B");
      const result = recordValidationError(state, "Error: cannot find module C");
      expect(result).toBeNull();
    });

    it("resets count when a different error interrupts", () => {
      const state = createLoopDetectorState();
      recordValidationError(state, "Error: X");
      recordValidationError(state, "Error: X");
      recordValidationError(state, "Error: Y"); // interrupts
      const result = recordValidationError(state, "Error: X");
      expect(result).toBeNull(); // only 1 consecutive now
    });

    it("normalizes timestamps in error output", () => {
      const state = createLoopDetectorState();
      recordValidationError(state, "2026-03-22T10:00:00.123 Error: fail");
      recordValidationError(state, "2026-03-22T10:01:00.456 Error: fail");
      const result = recordValidationError(state, "2026-03-22T10:02:00.789 Error: fail");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("repeated_validation_error");
    });

    it("triggers within 1 turn of meeting threshold", () => {
      const state = createLoopDetectorState();
      recordValidationError(state, "Error: same thing");
      recordValidationError(state, "Error: same thing");
      // Third call should trigger immediately
      const result = recordValidationError(state, "Error: same thing");
      expect(result).not.toBeNull();
    });
  });

  describe("recordToolCall", () => {
    it("does not trigger below 3 repetitions", () => {
      const state = createLoopDetectorState();
      expect(recordToolCall(state, "writeFile", '{"path":"a.ts"}')).toBeNull();
      expect(recordToolCall(state, "writeFile", '{"path":"a.ts"}')).toBeNull();
    });

    it("triggers on 3 consecutive identical tool calls", () => {
      const state = createLoopDetectorState();
      recordToolCall(state, "writeFile", '{"path":"a.ts","content":"hello"}');
      recordToolCall(state, "writeFile", '{"path":"a.ts","content":"hello"}');
      const result = recordToolCall(state, "writeFile", '{"path":"a.ts","content":"hello"}');
      expect(result).not.toBeNull();
      expect(result!.type).toBe("repeated_tool_call");
      expect(result!.detail).toContain("writeFile");
      expect(result!.detail).toContain("3 times");
    });

    it("does not trigger when params differ", () => {
      const state = createLoopDetectorState();
      recordToolCall(state, "writeFile", '{"path":"a.ts"}');
      recordToolCall(state, "writeFile", '{"path":"b.ts"}');
      const result = recordToolCall(state, "writeFile", '{"path":"c.ts"}');
      expect(result).toBeNull();
    });

    it("does not trigger when tool names differ", () => {
      const state = createLoopDetectorState();
      recordToolCall(state, "readFile", '{"path":"a.ts"}');
      recordToolCall(state, "writeFile", '{"path":"a.ts"}');
      const result = recordToolCall(state, "readFile", '{"path":"a.ts"}');
      expect(result).toBeNull(); // only 1 consecutive
    });
  });

  describe("loop detection triggers within 1 turn of threshold", () => {
    it("file write detection triggers on the exact 4th write", () => {
      const state = createLoopDetectorState();
      expect(recordFileWrite(state, "f.ts")).toBeNull();
      expect(recordFileWrite(state, "f.ts")).toBeNull();
      expect(recordFileWrite(state, "f.ts")).toBeNull();
      // 4th write triggers immediately
      expect(recordFileWrite(state, "f.ts")).not.toBeNull();
    });

    it("validation error detection triggers on the exact 3rd identical error", () => {
      const state = createLoopDetectorState();
      expect(recordValidationError(state, "err")).toBeNull();
      expect(recordValidationError(state, "err")).toBeNull();
      expect(recordValidationError(state, "err")).not.toBeNull();
    });

    it("tool call detection triggers on the exact 3rd identical call", () => {
      const state = createLoopDetectorState();
      expect(recordToolCall(state, "t", "p")).toBeNull();
      expect(recordToolCall(state, "t", "p")).toBeNull();
      expect(recordToolCall(state, "t", "p")).not.toBeNull();
    });
  });
});
