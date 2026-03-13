import type { AgentAdapter, AgentOptions } from "./types.js";

export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",

  buildShellCommand(promptFile: string, options: AgentOptions): string {
    let cmd = `cat "${promptFile}" | claude -p - --output-format text --dangerously-skip-permissions`;

    if (options.maxTurns > 0) {
      cmd += ` --max-turns ${options.maxTurns}`;
    }

    if (options.model) {
      cmd += ` --model ${shellEscape(options.model)}`;
    }

    for (const flag of options.flags) {
      cmd += ` ${shellEscape(flag)}`;
    }

    return cmd;
  },
};

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
