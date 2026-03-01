import type { AgentAdapter, AgentOptions } from "./types.js";

export const codexAdapter: AgentAdapter = {
  name: "codex",

  buildShellCommand(promptFile: string, options: AgentOptions): string {
    // codex exec: non-interactive mode for scripted/CI runs
    // --yolo: bypass sandbox + approvals (safe — we're already inside a Docker container)
    // --skip-git-repo-check: allow running outside git repos (for files-mode workflows)
    // Prompt piped from stdin via -
    let cmd = `cat "${promptFile}" | codex exec --yolo --skip-git-repo-check -`;

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
