import type { TrackerIssue } from "../tracker/types.js";

/**
 * Strict prompt template renderer. Replaces {{key.path}} variables.
 * Unlike expandTemplate (which leaves unresolved vars as-is), this throws
 * on unknown variables, serializes arrays as JSON, and renders null as "".
 */
export function renderPromptTemplate(
  template: string,
  vars: Record<string, unknown>,
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, key: string) => {
    const parts = key.split(".");
    let value: unknown = vars;

    for (const part of parts) {
      if (value == null || typeof value !== "object") {
        throw new Error(`Unknown template variable: ${match}`);
      }
      const obj = value as Record<string, unknown>;
      if (!(part in obj)) {
        throw new Error(`Unknown template variable: ${match}`);
      }
      value = obj[part];
    }

    // Null/undefined -> empty string
    if (value == null) {
      return "";
    }

    // Arrays -> JSON
    if (Array.isArray(value)) {
      return JSON.stringify(value);
    }

    return String(value);
  });
}

/**
 * Build the template variable map from a TrackerIssue and attempt number.
 * - All issue fields are nested under `issue.*`
 * - null priority is mapped to "" for template rendering
 * - attempt: null (first run) is mapped to ""
 */
export function buildTemplateVars(
  issue: TrackerIssue,
  attempt: number | null,
): Record<string, unknown> {
  // Build issue fields, mapping null values to empty string
  const issueVars: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(issue)) {
    issueVars[key] = value === null ? "" : value;
  }

  return {
    issue: issueVars,
    attempt: attempt === null ? "" : attempt,
  };
}
