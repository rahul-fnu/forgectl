/**
 * Generic clarification utilities — detect when an agent is asking for
 * clarification and extract the question from its output.
 */

/** Patterns that indicate the agent is asking for clarification. */
export const CLARIFICATION_PATTERNS = [
  /\bI need clarification\b/i,
  /\bWhich approach\b/i,
  /\bShould I\b/i,
  /\bunclear whether\b/i,
  /\bplease clarify\b/i,
  /\bcould you specify\b/i,
  /\bdo you want me to\b/i,
  /\bwhich option\b/i,
];

/**
 * Scan agent output for clarification patterns.
 * Returns the first matching line or undefined if no clarification is detected.
 */
export function detectClarificationNeed(agentOutput: string): string | undefined {
  const lines = agentOutput.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const pattern of CLARIFICATION_PATTERNS) {
      if (pattern.test(trimmed)) {
        return trimmed;
      }
    }
  }
  return undefined;
}

/**
 * Extract a concise question from the agent output around the clarification line.
 * Takes the matched line plus up to 2 surrounding lines for context.
 */
export function extractQuestion(agentOutput: string, matchedLine: string): string {
  const lines = agentOutput.split("\n");
  const idx = lines.findIndex((l) => l.trim() === matchedLine);
  if (idx === -1) return matchedLine;

  const start = Math.max(0, idx - 1);
  const end = Math.min(lines.length, idx + 3);
  return lines
    .slice(start, end)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Callback type for clarification requests from agent sessions.
 * Resolves with the user's reply or undefined if skipped/timed out.
 */
export type ClarificationCallback = (question: string) => Promise<string | undefined>;
