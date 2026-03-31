import path from "node:path";

/**
 * Sanitize an identifier to contain only safe characters [A-Za-z0-9._-].
 * Replaces all other characters with underscore.
 * Throws on empty, ".", or ".." results.
 */
export function sanitizeIdentifier(identifier: string): string {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/g, "_");

  // Collapse consecutive underscores and trim leading/trailing underscores
  const trimmed = sanitized.replace(/^_+|_+$/g, "").replace(/_+/g, "_");

  if (trimmed === "" || trimmed === "." || trimmed === "..") {
    throw new Error(
      `Invalid identifier "${identifier}": sanitized result "${trimmed}" is unsafe`,
    );
  }

  return sanitized;
}

/**
 * Assert that a target path is contained within a root directory.
 * Both paths are resolved to absolute before comparison.
 * Throws with "Path traversal detected" if target escapes root.
 */
export function assertContainment(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);

  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(
      `Path traversal detected: "${target}" resolves outside "${root}"`,
    );
  }
}
