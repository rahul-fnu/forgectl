import type { RepoContext, IssueContext } from "./types.js";
import type { RunRepository } from "../storage/repositories/runs.js";
import type { TrackerIssue } from "../tracker/types.js";
import { approveRun, rejectRun } from "../governance/approval.js";

/** Octokit-like interface for reaction handling. */
interface OctokitLike {
  rest: {
    issues: {
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<{ data: { id: number } }>;
    };
    reactions: {
      createForIssueComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        content: string;
      }): Promise<unknown>;
    };
    repos: {
      getCollaboratorPermissionLevel(params: {
        owner: string;
        repo: string;
        username: string;
      }): Promise<{ data: { permission: string } }>;
    };
  };
}

/** Dependencies injected into the reaction handler. */
export interface ReactionDeps {
  runRepo: RunRepository;
  onDispatch: (issue: TrackerIssue, octokit: OctokitLike, repo: RepoContext) => void;
  onRerun: (runId: string, octokit: OctokitLike, context: IssueContext) => Promise<void>;
}

/** Reaction payload shape from GitHub webhook. */
interface ReactionPayload {
  action: string;
  reaction: {
    content: string;
    user: { login: string; type: string };
  };
  comment?: {
    id: number;
    user: { login: string; type: string };
    performed_via_github_app?: { id: number } | null;
  };
  issue: {
    number: number;
    user: { login: string };
  };
  repository: {
    owner: { login: string };
    name: string;
    full_name: string;
  };
}

/**
 * Map of GitHub reaction content strings to forgectl actions.
 * Valid GitHub reactions: "+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"
 * Note: :arrows_counterclockwise: is not a valid GitHub reaction. Rerun is handled via slash command.
 */
const REACTION_MAP: Record<string, string> = {
  "+1": "approve",
  "-1": "reject",
  rocket: "trigger",
};

const WRITE_PERMISSIONS = new Set(["write", "admin"]);

function isBotComment(comment: ReactionPayload["comment"]): boolean {
  if (!comment) return false;
  return (
    comment.user.type === "Bot" || comment.performed_via_github_app != null
  );
}

async function hasWriteAccess(
  octokit: OctokitLike,
  repo: RepoContext,
  username: string,
): Promise<boolean> {
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: repo.owner,
      repo: repo.repo,
      username,
    });
    return WRITE_PERMISSIONS.has(data.permission);
  } catch {
    return false;
  }
}

/**
 * Handle a reaction event from GitHub webhooks.
 *
 * - Reactions on issue body: only "rocket" triggers a new run
 * - Reactions on bot comments: "+1" approves, "-1" rejects, requires write access
 * - Reactions on non-bot comments are ignored
 * - Non-collaborator reactions are silently ignored
 */
export async function handleReactionEvent(
  payload: ReactionPayload,
  octokit: OctokitLike,
  deps: ReactionDeps,
): Promise<void> {
  const { reaction, comment, issue, repository } = payload;
  const repo: RepoContext = {
    owner: repository.owner.login,
    repo: repository.name,
  };

  const action = REACTION_MAP[reaction.content];
  if (!action) return; // Unrecognized reaction, ignore

  const isIssueBody = !comment;

  if (isIssueBody) {
    // Only rocket on issue body triggers dispatch
    if (action !== "trigger") return;

    // Check write access for issue body reactions too
    const canWrite = await hasWriteAccess(octokit, repo, reaction.user.login);
    if (!canWrite) return;

    const trackerIssue: TrackerIssue = {
      id: String(issue.number),
      identifier: `#${issue.number}`,
      title: "",
      description: "",
      state: "open",
      priority: null,
      labels: [],
      assignees: [],
      url: "",
      created_at: "",
      updated_at: "",
      blocked_by: [],
      metadata: {},
    };

    deps.onDispatch(trackerIssue, octokit, repo);
    return;
  }

  // Comment reaction
  if (!isBotComment(comment)) return; // Not a bot comment, ignore

  // Check write access
  const canWrite = await hasWriteAccess(octokit, repo, reaction.user.login);
  if (!canWrite) return;

  // Look up the run associated with this comment
  const run = deps.runRepo.findByGithubCommentId(comment!.id);
  if (!run) return; // No run associated, ignore

  // Add :eyes: acknowledgment reaction
  await octokit.rest.reactions.createForIssueComment({
    owner: repo.owner,
    repo: repo.repo,
    comment_id: comment!.id,
    content: "eyes",
  });

  switch (action) {
    case "approve":
      approveRun(deps.runRepo, run.id);
      break;
    case "reject":
      rejectRun(deps.runRepo, run.id);
      break;
    case "trigger":
      deps.onDispatch(
        {
          id: String(issue.number),
          identifier: `#${issue.number}`,
          title: "",
          description: "",
          state: "open",
          priority: null,
          labels: [],
          assignees: [],
          url: "",
          created_at: "",
          updated_at: "",
          blocked_by: [],
          metadata: {},
        },
        octokit,
        repo,
      );
      break;
  }
}
