import type { App } from "@octokit/app";
import type { Octokit } from "@octokit/core";
import type { TrackerIssue } from "../tracker/types.js";
import type { ParsedCommand, RepoContext, IssueContext } from "./types.js";
import type { RunRepository } from "../storage/repositories/runs.js";
import { parseSlashCommand, buildErrorMessage } from "./commands.js";
import { hasWriteAccess } from "./permissions.js";

/** Dependencies injected into webhook handlers for testability. */
export interface WebhookDeps {
  /** Label that triggers automatic dispatch (e.g., "forgectl"). */
  triggerLabel: string;
  /** Callback when a label trigger or opened-with-label event fires. */
  onDispatch: (issue: TrackerIssue, octokit: Octokit, repo: RepoContext) => void;
  /** Callback when an authorized slash command is received. */
  onCommand: (
    cmd: ParsedCommand,
    octokit: Octokit,
    context: IssueContext,
    sender: string,
    commentId: number,
  ) => Promise<void>;
  /** Run repository for looking up runs. */
  runRepo: RunRepository;
}

/**
 * Convert a GitHub webhook issue payload to a TrackerIssue.
 */
export function webhookPayloadToTrackerIssue(payload: {
  issue: {
    number: number;
    title: string;
    body: string | null;
    state: string;
    labels: Array<{ name: string }>;
    assignees: Array<{ login: string }>;
    user: { login: string };
    html_url: string;
    created_at: string;
    updated_at: string;
  };
  repository: {
    owner: { login: string };
    name: string;
    full_name: string;
  };
}): TrackerIssue {
  const { issue, repository } = payload;
  return {
    id: String(issue.number),
    identifier: `${repository.full_name}#${issue.number}`,
    title: issue.title,
    description: issue.body ?? "",
    state: issue.state,
    priority: null,
    labels: issue.labels.map((l) => l.name),
    assignees: issue.assignees.map((a) => a.login),
    url: issue.html_url,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    blocked_by: [],
    metadata: {
      author: issue.user.login,
      repo: repository.full_name,
    },
  };
}

/**
 * Register webhook event handlers on the GitHub App.
 * Handles issues.labeled, issues.opened, and issue_comment.created events.
 */
export function registerWebhookHandlers(app: App, deps: WebhookDeps): void {
  // Label trigger: dispatch when matching label is added
  app.webhooks.on("issues.labeled", async ({ payload, octokit }) => {
    const { label, repository } = payload;
    if (label?.name !== deps.triggerLabel) return;

    const issue = webhookPayloadToTrackerIssue(payload as any);
    const repo: RepoContext = {
      owner: repository.owner.login,
      repo: repository.name,
    };
    deps.onDispatch(issue, octokit as unknown as Octokit, repo);
  });

  // Opened trigger: dispatch if issue is opened with matching label
  app.webhooks.on("issues.opened", async ({ payload, octokit }) => {
    const { issue, repository } = payload;
    const hasLabel = issue.labels?.some(
      (l) => (l as any).name === deps.triggerLabel,
    );
    if (!hasLabel) return;

    const trackerIssue = webhookPayloadToTrackerIssue(payload as any);
    const repo: RepoContext = {
      owner: repository.owner.login,
      repo: repository.name,
    };
    deps.onDispatch(trackerIssue, octokit as unknown as Octokit, repo);
  });

  // Comment handler: parse slash commands, check permissions, dispatch
  app.webhooks.on("issue_comment.created", async ({ payload, octokit }) => {
    const { comment, issue, repository } = payload;

    // Skip bot comments
    if (comment.user?.type === "Bot") return;

    // Parse slash command from comment body
    const cmd = parseSlashCommand(comment.body);
    if (!cmd) return;

    const owner = repository.owner.login;
    const repo = repository.name;
    const sender = comment.user?.login ?? "unknown";

    // Check permissions
    const authorized = await hasWriteAccess(
      octokit as unknown as Octokit,
      owner,
      repo,
      sender,
    );

    if (!authorized) {
      // Add :x: reaction and post error reply
      await (octokit as any).rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: comment.id,
        content: "-1",
      });
      await (octokit as any).rest.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: buildErrorMessage(
          `@${sender} does not have write access to this repository.`,
        ),
      });
      return;
    }

    // Add :eyes: acknowledgment reaction
    await (octokit as any).rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: comment.id,
      content: "eyes",
    });

    // Dispatch command
    const context: IssueContext = {
      owner,
      repo,
      issueNumber: issue.number,
    };
    await deps.onCommand(cmd, octokit as unknown as Octokit, context, sender, comment.id);
  });
}
