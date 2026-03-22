export type LoopPattern =
  | { kind: "repeated_file_writes"; files: string[]; writeCount: number }
  | { kind: "repeated_validation_error"; error: string; count: number }
  | { kind: "repeated_tool_call"; tool: string; params: string; count: number };

export interface LoopDetectorOptions {
  maxFileWrites?: number;       // default 4
  maxUniqueFiles?: number;      // default 2
  maxRepeatedErrors?: number;   // default 3
  maxRepeatedToolCalls?: number; // default 3
}

const DEFAULTS: Required<LoopDetectorOptions> = {
  maxFileWrites: 4,
  maxUniqueFiles: 2,
  maxRepeatedErrors: 3,
  maxRepeatedToolCalls: 3,
};

export class LoopDetector {
  private fileWrites: Map<string, number> = new Map();
  private validationErrors: Map<string, number> = new Map();
  private toolCalls: Map<string, number> = new Map();
  private readonly opts: Required<LoopDetectorOptions>;

  constructor(options?: LoopDetectorOptions) {
    this.opts = { ...DEFAULTS, ...options };
  }

  recordFileWrite(filePath: string): LoopPattern | null {
    this.fileWrites.set(filePath, (this.fileWrites.get(filePath) ?? 0) + 1);
    return this.checkFileWriteLoop();
  }

  recordValidationError(errorText: string): LoopPattern | null {
    const normalized = normalizeError(errorText);
    this.validationErrors.set(normalized, (this.validationErrors.get(normalized) ?? 0) + 1);
    const count = this.validationErrors.get(normalized)!;
    if (count >= this.opts.maxRepeatedErrors) {
      return { kind: "repeated_validation_error", error: normalized, count };
    }
    return null;
  }

  recordToolCall(tool: string, params: Record<string, unknown>): LoopPattern | null {
    const key = `${tool}::${JSON.stringify(params)}`;
    this.toolCalls.set(key, (this.toolCalls.get(key) ?? 0) + 1);
    const count = this.toolCalls.get(key)!;
    if (count >= this.opts.maxRepeatedToolCalls) {
      return { kind: "repeated_tool_call", tool, params: JSON.stringify(params), count };
    }
    return null;
  }

  reset(): void {
    this.fileWrites.clear();
    this.validationErrors.clear();
    this.toolCalls.clear();
  }

  private checkFileWriteLoop(): LoopPattern | null {
    const totalWrites = Array.from(this.fileWrites.values()).reduce((a, b) => a + b, 0);
    if (totalWrites < this.opts.maxFileWrites) return null;

    const filesWithMultipleWrites = Array.from(this.fileWrites.entries())
      .filter(([, count]) => count >= 2)
      .map(([file]) => file);

    if (filesWithMultipleWrites.length > 0 && filesWithMultipleWrites.length <= this.opts.maxUniqueFiles) {
      return {
        kind: "repeated_file_writes",
        files: filesWithMultipleWrites,
        writeCount: totalWrites,
      };
    }
    return null;
  }
}

function normalizeError(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 500);
}

export function describeLoopPattern(pattern: LoopPattern): string {
  switch (pattern.kind) {
    case "repeated_file_writes":
      return `Agent wrote to the same file(s) repeatedly (${pattern.writeCount} writes to ${pattern.files.length} file(s): ${pattern.files.join(", ")})`;
    case "repeated_validation_error":
      return `Same validation error repeated ${pattern.count} times: ${pattern.error.slice(0, 200)}`;
    case "repeated_tool_call":
      return `Agent made identical tool call ${pattern.count} times: ${pattern.tool}`;
  }
}
