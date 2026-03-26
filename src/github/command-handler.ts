import type { TrackerIssue } from "../tracker/types.js";
import type { ParsedCommand, IssueContext } from "./types.js";
import type { RunRepository, RunRow } from "../storage/repositories/runs.js";
import { buildHelpMessage, buildErrorMessage } from "./commands.js";

/** Minimal orchestrator interface needed by the command handler. */
export interface OrchestratorLike {
  dispatchIssue(issue: TrackerIssue): void | Promise<void>;
  isRunning(): boolean;
}

/** Dependencies for the slash command handler. */
export interface CommandHandlerDeps {
  orchestrator: OrchestratorLike | null;
  runRepo: RunRepository;
  approveRun?: (runRepo: RunRepository, runId: string) => { previousStatus: string };
  rejectRun?: (runRepo: RunRepository, runId: string) => void;
}

/** OctokitLike interface to avoid tight coupling to specific Octokit types. */
interface OctokitLike {
  rest: {
    issues: {
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<unknown>;
    };
  };
}

/** Active run statuses for stop command. */
const ACTIVE_STATUSES = ["running"];

/** Pending approval statuses for approve/reject commands. */
const PENDING_STATUSES = ["pending_approval", "pending_output_approval"];

/** All statuses to search when looking for any run related to an issue. */
const ALL_SEARCHABLE_STATUSES = [
  "running",
  "pending_approval",
  "pending_output_approval",
  "waiting_for_input",
  "queued",
];

/**
 * Find a run associated with a specific issue, optionally filtering by status.
 * Matches by issueContext in options or by task string containing the issue identifier.
 */
export function findRunForIssue(
  runRepo: RunRepository,
  context: IssueContext,
  statuses?: string[],
): RunRow | undefined {
  const statusList = statuses ?? ALL_SEARCHABLE_STATUSES;
  const identifier = `${context.owner}/${context.repo}#${context.issueNumber}`;

  for (const status of statusList) {
    const runs = runRepo.findByStatus(status);
    for (const run of runs) {
      // Match by issueContext in options
      const opts = run.options as Record<string, unknown> | null;
      if (opts) {
        const issueCtx = opts.issueContext as {
          owner?: string;
          repo?: string;
          issueNumber?: number;
        } | undefined;
        if (
          issueCtx?.owner === context.owner &&
          issueCtx?.repo === context.repo &&
          issueCtx?.issueNumber === context.issueNumber
        ) {
          return run;
        }
      }

      // Fallback: match by task string containing identifier
      if (run.task.includes(identifier)) {
        return run;
      }
    }
  }

  return undefined;
}

/**
 * Convert an IssueContext to a minimal TrackerIssue for dispatching.
 */
function contextToTrackerIssue(context: IssueContext): TrackerIssue {
  return {
    id: String(context.issueNumber),
    identifier: `${context.owner}/${context.repo}#${context.issueNumber}`,
    title: `Issue #${context.issueNumber}`,
    description: "",
    state: "open",
    priority: null,
    labels: [],
    assignees: [],
    url: "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    blocked_by: [],
    metadata: {
      owner: context.owner,
      repo: context.repo,
    },
  };
}

/**
 * Post a comment on the issue.
 */
async function postComment(
  octokit: OctokitLike,
  context: IssueContext,
  body: string,
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner: context.owner,
    repo: context.repo,
    issue_number: context.issueNumber,
    body,
  });
}

/**
 * Handle a parsed slash command by routing to the appropriate action.
 * Extracted from server.ts for testability.
 */
export async function handleSlashCommand(
  cmd: ParsedCommand,
  octokit: OctokitLike,
  context: IssueContext,
  _sender: string,
  _commentId: number,
  deps: CommandHandlerDeps,
): Promise<void> {
  const { orchestrator, runRepo } = deps;

  switch (cmd.command) {
    case "run":
    case "rerun": {
      if (orchestrator) {
        const trackerIssue = contextToTrackerIssue(context);
        void orchestrator.dispatchIssue(trackerIssue);
      } else {
        await postComment(octokit, context, buildErrorMessage("Orchestrator is not running"));
      }
      break;
    }

    case "stop": {
      const activeRun = findRunForIssue(runRepo, context, ACTIVE_STATUSES);
      if (activeRun) {
        runRepo.updateStatus(activeRun.id, { status: "cancelled" });
        await postComment(
          octokit,
          context,
          `Run \`${activeRun.id}\` has been stopped.`,
        );
      } else {
        await postComment(
          octokit,
          context,
          buildErrorMessage("No active run found for this issue"),
        );
      }
      break;
    }

    case "status": {
      const statusRun = findRunForIssue(runRepo, context);
      if (statusRun) {
        await postComment(
          octokit,
          context,
          `**Run status:** \`${statusRun.status}\` (run ID: \`${statusRun.id}\`)`,
        );
      } else {
        await postComment(
          octokit,
          context,
          buildErrorMessage("No run found for this issue"),
        );
      }
      break;
    }

    case "approve": {
      const approveTarget = findRunForIssue(runRepo, context, PENDING_STATUSES);
      if (approveTarget && deps.approveRun) {
        deps.approveRun(runRepo, approveTarget.id);
        await postComment(
          octokit,
          context,
          `Run \`${approveTarget.id}\` approved.`,
        );
      } else if (!approveTarget) {
        await postComment(
          octokit,
          context,
          buildErrorMessage("No run pending approval for this issue"),
        );
      }
      break;
    }

    case "reject": {
      const rejectTarget = findRunForIssue(runRepo, context, PENDING_STATUSES);
      if (rejectTarget && deps.rejectRun) {
        deps.rejectRun(runRepo, rejectTarget.id);
        await postComment(
          octokit,
          context,
          `Run \`${rejectTarget.id}\` rejected.`,
        );
      } else if (!rejectTarget) {
        await postComment(
          octokit,
          context,
          buildErrorMessage("No run pending approval for this issue"),
        );
      }
      break;
    }

    case "help": {
      await postComment(octokit, context, buildHelpMessage());
      break;
    }
  }
}
