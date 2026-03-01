/**
 * Expand {{variable}} placeholders in a template string.
 * Supports nested keys like {{commit.prefix}}.
 * Unresolved placeholders are left as-is.
 */
export function expandTemplate(
  template: string,
  vars: Record<string, unknown>
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, key: string) => {
    const parts = key.split(".");
    let value: unknown = vars;
    for (const part of parts) {
      if (value == null || typeof value !== "object") return match;
      value = (value as Record<string, unknown>)[part];
    }
    return value != null ? String(value) : match;
  });
}
