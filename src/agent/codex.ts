import type { AgentAdapter, AgentOptions } from "./types.js";

export const codexAdapter: AgentAdapter = {
  name: "codex",

  buildShellCommand(promptFile: string, options: AgentOptions): string {
    // codex exec: non-interactive mode for scripted/CI runs
    // --yolo: bypass sandbox + approvals (safe — we're already inside a Docker container)
    // --skip-git-repo-check: allow running outside git repos (for files-mode workflows)
    // Prompt passed as positional argument via command substitution.
    // "$(cat file)" captures the full file and passes it as a single arg — safe for any
    // prompt content (including double quotes) and avoids stdin-pipe issues with codex exec.
    let cmd = `codex exec --yolo --skip-git-repo-check`;

    if (options.model) {
      cmd += ` --model ${shellEscape(options.model)}`;
    }

    for (const flag of options.flags) {
      cmd += ` ${shellEscape(flag)}`;
    }

    cmd += ` "$(cat "${promptFile}")"`;

    return cmd;
  },
};

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
