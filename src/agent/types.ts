export interface AgentAdapter {
  name: string;
  /** Build the command array to exec inside the container */
  buildCommand(prompt: string, options: AgentOptions): string[];
  /** Build environment variables needed (as shell-style KEY=VALUE strings) */
  buildEnv(secretEnv: Record<string, string>): string[];
}

export interface AgentOptions {
  model: string;
  maxTurns: number;
  timeout: number;     // ms
  flags: string[];
  workingDir: string;
}
