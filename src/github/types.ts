/** Configuration for GitHub App integration. */
export interface GitHubAppConfig {
  appId: number;
  privateKeyPath: string;
  webhookSecret: string;
  installationId?: number;
}

/** Repository context for GitHub API calls. */
export interface RepoContext {
  owner: string;
  repo: string;
}

/** Issue context extending RepoContext with issue number. */
export interface IssueContext extends RepoContext {
  issueNumber: number;
}

/** Supported slash-command types parsed from issue comments. */
export type CommandType =
  | "run"
  | "rerun"
  | "stop"
  | "status"
  | "approve"
  | "reject"
  | "help";

/** A parsed slash command from an issue comment. */
export interface ParsedCommand {
  command: CommandType;
  args: string[];
}
