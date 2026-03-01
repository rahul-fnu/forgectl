import type { AgentAdapter, AgentOptions } from "./types.js";

export const codexAdapter: AgentAdapter = {
  name: "codex",

  buildCommand(prompt: string, options: AgentOptions): string[] {
    const cmd = [
      "codex",
      "--quiet",
      "--approval-mode", "full-auto",
      prompt,
    ];

    if (options.model) {
      cmd.push("--model", options.model);
    }

    for (const flag of options.flags) {
      cmd.push(flag);
    }

    return cmd;
  },

  buildEnv(secretEnv: Record<string, string>): string[] {
    const env: string[] = [];
    if (secretEnv.OPENAI_API_KEY_FILE) {
      env.push(`OPENAI_API_KEY=$(cat ${secretEnv.OPENAI_API_KEY_FILE})`);
    }
    return env;
  },
};
