import { createHash } from "node:crypto";

export interface FailureSignature {
  stepName: string;
  category: "test" | "lint" | "typecheck" | "runtime" | "unknown";
  key: string;
  raw: string;
}

const VITEST_JEST_RE = /FAIL\s+(\S+)\s*>\s*(.+)/;
const PYTEST_RE = /FAILED\s+(\S+::[\w_]+)/;
const ESLINT_LINE_RE = /\d+:\d+\s+(error|warning)\s+.+?\s+(@?[\w-]+(?:\/[\w-]+)*)\s*$/m;
const TS_ERROR_RE = /(\S+\.tsx?)\(?\d+[,)].+?\b(TS\d+)/;
const TS_ERROR_ALT_RE = /(TS\d+)\b.*?(\S+\.tsx?)/;
const RUNTIME_ERROR_RE = /^(\w*Error):\s*(.+)/m;

export function extractFailureSignature(
  stepName: string,
  output: string,
): FailureSignature {
  const raw = output.slice(0, 200);

  // Test failures: vitest/jest
  const vitestMatch = output.match(VITEST_JEST_RE);
  if (vitestMatch) {
    return {
      stepName,
      category: "test",
      key: vitestMatch[2].trim(),
      raw,
    };
  }

  // Test failures: pytest
  const pytestMatch = output.match(PYTEST_RE);
  if (pytestMatch) {
    return {
      stepName,
      category: "test",
      key: pytestMatch[1],
      raw,
    };
  }

  // Typecheck errors (check before lint since tsc output can contain rule-like patterns)
  const tsMatch = output.match(TS_ERROR_RE);
  if (tsMatch) {
    return {
      stepName,
      category: "typecheck",
      key: `${tsMatch[2]} ${tsMatch[1]}`,
      raw,
    };
  }
  const tsAltMatch = output.match(TS_ERROR_ALT_RE);
  if (tsAltMatch) {
    return {
      stepName,
      category: "typecheck",
      key: `${tsAltMatch[1]} ${tsAltMatch[2]}`,
      raw,
    };
  }

  // Lint errors: eslint-style "line:col error msg rule-id"
  const eslintLineMatch = output.match(ESLINT_LINE_RE);
  if (eslintLineMatch) {
    return {
      stepName,
      category: "lint",
      key: eslintLineMatch[2],
      raw,
    };
  }

  // Lint errors: generic rule ID (e.g. E501, W0611)
  const pyLintRe = /\b([EWCRF]\d{3,4})\b/;
  const pyLintMatch = output.match(pyLintRe);
  if (pyLintMatch) {
    return {
      stepName,
      category: "lint",
      key: pyLintMatch[1],
      raw,
    };
  }

  // Runtime errors
  const runtimeMatch = output.match(RUNTIME_ERROR_RE);
  if (runtimeMatch) {
    return {
      stepName,
      category: "runtime",
      key: `${runtimeMatch[1]}: ${runtimeMatch[2].slice(0, 80)}`,
      raw,
    };
  }

  // Fallback: hash first 200 chars
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return {
    stepName,
    category: "unknown",
    key: hash,
    raw,
  };
}
