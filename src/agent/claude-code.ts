import type { AgentAdapter, AgentOptions } from "./types.js";

export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",

  buildCommand(prompt: string, options: AgentOptions): string[] {
    const cmd = [
      "claude",
      "-p", prompt,
      "--output-format", "text",
    ];

    if (options.maxTurns > 0) {
      cmd.push("--max-turns", String(options.maxTurns));
    }

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
    if (secretEnv.ANTHROPIC_API_KEY_FILE) {
      env.push(`ANTHROPIC_API_KEY=$(cat ${secretEnv.ANTHROPIC_API_KEY_FILE})`);
    }
    env.push("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
    return env;
  },
};
