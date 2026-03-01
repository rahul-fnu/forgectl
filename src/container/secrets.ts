export { prepareClaudeMounts, prepareCodexMounts } from "../auth/mount.js";

/**
 * Build the env injection prefix for running an agent command.
 * This reads the secret from the mounted file and sets it as an env var
 * only in the agent's process.
 */
export function buildSecretEnvPrefix(envMapping: Record<string, string>): string {
  const parts: string[] = [];
  for (const [envVar, filePath] of Object.entries(envMapping)) {
    parts.push(`${envVar}=$(cat ${filePath})`);
  }
  return parts.join(" ");
}
