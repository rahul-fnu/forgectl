import type { AgentAdapter, AgentOptions } from "./types.js";

export const codexAdapter: AgentAdapter = {
  name: "codex",

  buildShellCommand(promptFile: string, options: AgentOptions): string {
    let cmd = `codex --quiet --approval-mode full-auto "$(cat "${promptFile}")"`;

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
