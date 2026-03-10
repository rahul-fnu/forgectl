import type { CommandType, ParsedCommand } from "./types.js";

/** The set of valid slash command names. */
const VALID_COMMANDS = new Set<CommandType>([
  "run",
  "rerun",
  "stop",
  "status",
  "approve",
  "reject",
  "help",
]);

/**
 * Parse a slash command from an issue comment body.
 * Matches `/forgectl <command> [args...]` on any line.
 * Returns null if no valid command is found.
 */
export function parseSlashCommand(body: string): ParsedCommand | null {
  const match = body.match(/^\/forgectl[ \t]+(\w+)(?:[ \t]+(.+))?$/m);
  if (!match) return null;

  const command = match[1] as CommandType;
  if (!VALID_COMMANDS.has(command)) return null;

  const args = match[2] ? match[2].trim().split(/\s+/) : [];
  return { command, args };
}

/** Build a help message listing all available commands. */
export function buildHelpMessage(): string {
  return [
    "**forgectl commands:**",
    "",
    "| Command | Description |",
    "|---------|-------------|",
    "| `/forgectl run [workflow]` | Start a new run for this issue |",
    "| `/forgectl rerun` | Re-run the last run for this issue |",
    "| `/forgectl stop` | Stop the active run for this issue |",
    "| `/forgectl status` | Show the current run status |",
    "| `/forgectl approve` | Approve a run pending approval |",
    "| `/forgectl reject` | Reject a run pending approval |",
    "| `/forgectl help` | Show this help message |",
  ].join("\n");
}

/** Build an error message with a reason. */
export function buildErrorMessage(reason: string): string {
  return `**forgectl error:** ${reason}`;
}
