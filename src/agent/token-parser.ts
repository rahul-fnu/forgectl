/**
 * Parse token usage from agent output.
 *
 * Claude Code prints token counts to stderr in a format like:
 *   Token usage: input=1234, output=567
 *   or: Input tokens: 1234 Output tokens: 567
 *   or: Total input tokens: 1,234 | Total output tokens: 567
 *
 * Codex includes token usage in JSON output:
 *   {"usage": {"prompt_tokens": 1234, "completion_tokens": 567, "total_tokens": 1801}}
 *   or: {"input_tokens": 1234, "output_tokens": 567}
 */
export interface ParsedTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Parse token usage from Claude Code stderr output.
 * Claude Code writes token information to stderr in various formats.
 */
export function parseClaudeCodeTokens(stderr: string): ParsedTokenUsage | null {
  if (!stderr) return null;

  // Pattern 1: "input=1234, output=567" or "input: 1234, output: 567"
  const kvMatch = stderr.match(/input[=:\s]+([0-9,]+).*?output[=:\s]+([0-9,]+)/i);
  if (kvMatch) {
    return {
      inputTokens: parseTokenNumber(kvMatch[1]),
      outputTokens: parseTokenNumber(kvMatch[2]),
    };
  }

  // Pattern 2: "Input tokens: 1234" and "Output tokens: 567" (separate lines or same line)
  const inputMatch = stderr.match(/input\s+tokens[:\s]+([0-9,]+)/i);
  const outputMatch = stderr.match(/output\s+tokens[:\s]+([0-9,]+)/i);
  if (inputMatch && outputMatch) {
    return {
      inputTokens: parseTokenNumber(inputMatch[1]),
      outputTokens: parseTokenNumber(outputMatch[1]),
    };
  }

  // Pattern 3: "Total input tokens: 1,234 | Total output tokens: 567"
  const totalInputMatch = stderr.match(/total\s+input\s+tokens[:\s]+([0-9,]+)/i);
  const totalOutputMatch = stderr.match(/total\s+output\s+tokens[:\s]+([0-9,]+)/i);
  if (totalInputMatch && totalOutputMatch) {
    return {
      inputTokens: parseTokenNumber(totalInputMatch[1]),
      outputTokens: parseTokenNumber(totalOutputMatch[1]),
    };
  }

  return null;
}

/**
 * Parse token usage from Codex JSON output.
 * Codex may include usage data in JSON format within stdout or stderr.
 */
export function parseCodexTokens(output: string): ParsedTokenUsage | null {
  if (!output) return null;

  // Try to find JSON blocks in the output
  const jsonBlocks = extractJsonBlocks(output);

  for (const block of jsonBlocks) {
    try {
      const parsed = JSON.parse(block) as Record<string, unknown>;

      // OpenAI-style usage object
      if (parsed.usage && typeof parsed.usage === "object") {
        const usage = parsed.usage as Record<string, unknown>;
        const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
        const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
        if (promptTokens > 0 || completionTokens > 0) {
          return { inputTokens: promptTokens, outputTokens: completionTokens };
        }
      }

      // Direct token fields
      const inputTokens = typeof parsed.input_tokens === "number" ? parsed.input_tokens : 0;
      const outputTokens = typeof parsed.output_tokens === "number" ? parsed.output_tokens : 0;
      if (inputTokens > 0 || outputTokens > 0) {
        return { inputTokens, outputTokens };
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  return null;
}

/**
 * Parse token usage from agent output, dispatching to the correct parser.
 */
export function parseTokenUsage(agentType: string, stdout: string, stderr: string): ParsedTokenUsage | null {
  if (agentType === "claude-code") {
    // Claude Code writes token info to stderr
    return parseClaudeCodeTokens(stderr);
  }

  if (agentType === "codex") {
    // Codex includes JSON in stdout, sometimes stderr
    return parseCodexTokens(stdout) ?? parseCodexTokens(stderr);
  }

  // For unknown agent types, try both approaches
  return parseClaudeCodeTokens(stderr) ?? parseCodexTokens(stdout);
}

/**
 * Parse a token number string, removing commas.
 */
function parseTokenNumber(s: string): number {
  return parseInt(s.replace(/,/g, ""), 10) || 0;
}

/**
 * Extract potential JSON blocks from a string.
 * Looks for top-level { ... } blocks.
 */
function extractJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        blocks.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return blocks;
}
