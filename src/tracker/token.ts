/**
 * Resolve a token value that may reference an environment variable.
 *
 * - "$GITHUB_TOKEN" => reads process.env.GITHUB_TOKEN
 * - "literal-value" => returns the string as-is
 *
 * Throws if the env var is not set or is empty.
 */
export function resolveToken(token: string): string {
  if (!token.startsWith("$")) {
    return token;
  }

  const varName = token.slice(1);
  const value = process.env[varName];

  if (!value) {
    throw new Error(`Tracker: environment variable "${varName}" is not set`);
  }

  return value;
}
