/**
 * Loop detector for agent sessions.
 *
 * Detects three patterns of agent stalls:
 * 1. Same file being written repeatedly (4+ writes to ≤2 files)
 * 2. Same validation error repeating 3+ times unchanged
 * 3. Same tool call with identical parameters repeating
 */

export interface LoopPattern {
  type: "repeated_file_writes" | "repeated_validation_error" | "repeated_tool_call" | "repeated_review_comments";
  detail: string;
}

export interface LoopDetectorState {
  fileWriteCounts: Map<string, number>;
  validationErrors: string[];
  toolCalls: string[];
  reviewCommentHashes: string[];
}

export function createLoopDetectorState(): LoopDetectorState {
  return {
    fileWriteCounts: new Map(),
    validationErrors: [],
    toolCalls: [],
    reviewCommentHashes: [],
  };
}

/**
 * Record a file write event. Returns a loop pattern if threshold is met.
 */
export function recordFileWrite(state: LoopDetectorState, filePath: string): LoopPattern | null {
  const count = (state.fileWriteCounts.get(filePath) ?? 0) + 1;
  state.fileWriteCounts.set(filePath, count);

  // Check: 4+ total writes across at most 2 distinct files
  const totalWrites = Array.from(state.fileWriteCounts.values()).reduce((a, b) => a + b, 0);
  const distinctFiles = state.fileWriteCounts.size;

  if (totalWrites >= 4 && distinctFiles <= 2) {
    const files = Array.from(state.fileWriteCounts.entries())
      .map(([f, c]) => `${f} (${c}x)`)
      .join(", ");
    return {
      type: "repeated_file_writes",
      detail: `${totalWrites} writes to ${distinctFiles} file(s): ${files}`,
    };
  }

  return null;
}

/**
 * Record a validation error. Returns a loop pattern if the same error appears 3+ times.
 */
export function recordValidationError(state: LoopDetectorState, errorOutput: string): LoopPattern | null {
  const normalized = normalizeError(errorOutput);
  state.validationErrors.push(normalized);

  // Count consecutive identical errors from the end
  let consecutiveCount = 0;
  for (let i = state.validationErrors.length - 1; i >= 0; i--) {
    if (state.validationErrors[i] === normalized) {
      consecutiveCount++;
    } else {
      break;
    }
  }

  if (consecutiveCount >= 3) {
    return {
      type: "repeated_validation_error",
      detail: `Same validation error repeated ${consecutiveCount} times: ${normalized.slice(0, 200)}`,
    };
  }

  return null;
}

/**
 * Record a tool call. Returns a loop pattern if the same call repeats 3+ times.
 */
export function recordToolCall(state: LoopDetectorState, toolName: string, params: string): LoopPattern | null {
  const key = `${toolName}:${params}`;
  state.toolCalls.push(key);

  // Count consecutive identical tool calls from the end
  let consecutiveCount = 0;
  for (let i = state.toolCalls.length - 1; i >= 0; i--) {
    if (state.toolCalls[i] === key) {
      consecutiveCount++;
    } else {
      break;
    }
  }

  if (consecutiveCount >= 3) {
    return {
      type: "repeated_tool_call",
      detail: `Tool "${toolName}" called ${consecutiveCount} times with identical parameters`,
    };
  }

  return null;
}

/**
 * Record review comments. Returns a loop pattern if the same set of comments appears 2+ times consecutively.
 * The comments are normalized by sorting and hashing file+line+severity+message.
 */
export function recordReviewComments(
  state: LoopDetectorState,
  comments: Array<{ file: string; line: number; severity: string; message?: string; comment?: string }>,
): LoopPattern | null {
  const normalized = comments
    .map(c => `${c.file}:${c.line}:${c.severity}:${c.message ?? c.comment ?? ""}`)
    .sort()
    .join("\n");
  state.reviewCommentHashes.push(normalized);

  let consecutiveCount = 0;
  for (let i = state.reviewCommentHashes.length - 1; i >= 0; i--) {
    if (state.reviewCommentHashes[i] === normalized) {
      consecutiveCount++;
    } else {
      break;
    }
  }

  if (consecutiveCount >= 2) {
    return {
      type: "repeated_review_comments",
      detail: `Same review comments repeated ${consecutiveCount} times (${comments.length} comments)`,
    };
  }

  return null;
}

/**
 * Normalize error output for comparison: trim whitespace, collapse runs of whitespace,
 * and remove timestamps/line numbers that change between runs.
 */
function normalizeError(error: string): string {
  return error
    .trim()
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*/g, "<TIMESTAMP>")
    .replace(/\s+/g, " ")
    .slice(0, 1000);
}
