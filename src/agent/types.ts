export interface AgentAdapter {
  name: string;
  /**
   * Build a shell command string that reads the prompt from a file.
   * The caller writes the prompt to `promptFile` inside the container,
   * then executes: ["sh", "-c", buildShellCommand(promptFile, options)]
   *
   * This avoids ARG_MAX limits and shell escaping issues with multi-KB prompts.
   */
  buildShellCommand(promptFile: string, options: AgentOptions): string;
}

export interface AgentOptions {
  model: string;
  maxTurns: number;
  timeout: number;     // ms
  flags: string[];
  workingDir: string;
}
