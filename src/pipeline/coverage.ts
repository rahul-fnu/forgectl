/**
 * Extract a coverage percentage from test runner output.
 *
 * Supports vitest, jest/istanbul (Statements), c8/istanbul (Lines), and a
 * generic fallback pattern. Returns -1 when no coverage percentage is found.
 */
export function extractCoverage(output: string): number {
  // vitest: "All files | 72.34 | ..."
  const vitestMatch = /All files\s*\|\s*([\d.]+)/.exec(output);
  if (vitestMatch) return parseFloat(vitestMatch[1]);

  // jest/istanbul: "Statements   : 85.5% ( 100/117 )"
  const statementsMatch = /Statements\s*:\s*([\d.]+)%/.exec(output);
  if (statementsMatch) return parseFloat(statementsMatch[1]);

  // c8/istanbul: "Lines        : 91.2% ( 200/219 )"
  const linesMatch = /Lines\s*:\s*([\d.]+)%/.exec(output);
  if (linesMatch) return parseFloat(linesMatch[1]);

  // Generic fallback: "91.2% coverage"
  const genericMatch = /([\d.]+)%\s*coverage/i.exec(output);
  if (genericMatch) return parseFloat(genericMatch[1]);

  return -1;
}
