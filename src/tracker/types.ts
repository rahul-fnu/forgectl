/**
 * Normalized issue model — tracker-agnostic representation of a work item.
 */
export interface TrackerIssue {
  /**
   * API-addressable identifier passed to all mutation methods (postComment, updateState, updateLabels).
   * For GitHub: issue number as string ('42'). For Notion: page UUID.
   */
  id: string;
  /**
   * Human-readable display identifier used in logs, comments, and UI.
   * For GitHub: '#42'. For Notion: short UUID prefix.
   */
  identifier: string;
  title: string;
  description: string;
  state: string;
  priority: string | null;
  labels: string[];
  assignees: string[];
  url: string;
  created_at: string;
  updated_at: string;
  blocked_by: string[];
  metadata: Record<string, unknown>;
}

/**
 * Adapter interface that GitHub and Notion (and future) tracker integrations implement.
 */
export interface TrackerAdapter {
  readonly kind: string;

  /** Fetch issues that are candidates for agent work (based on active states, labels, etc.) */
  fetchCandidateIssues(): Promise<TrackerIssue[]>;

  /** Fetch the current state of specific issues by their IDs. */
  fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>>;

  /** Fetch all issues in the given states. */
  fetchIssuesByStates(states: string[]): Promise<TrackerIssue[]>;

  /** Post a comment on an issue. */
  postComment(issueId: string, body: string): Promise<void>;

  /** Transition an issue to a new state. */
  updateState(issueId: string, state: string): Promise<void>;

  /** Add and/or remove labels on an issue. */
  updateLabels(issueId: string, add: string[], remove: string[]): Promise<void>;

  /** Create a new issue in the tracker. Returns the created issue's identifier. */
  createIssue?(title: string, description: string, labels?: string[]): Promise<string>;

  /** Create a sub-issue under a parent. Returns the created issue's identifier. */
  createSubIssue?(title: string, description: string, parentId: string): Promise<string>;

  /** Create a blocking relation: blockingIssueId blocks blockedIssueId. */
  createBlockingRelation?(blockingIssueId: string, blockedIssueId: string): Promise<void>;

  /** Create a pull request for a branch. Returns the PR URL, or undefined if not supported. */
  createPullRequest?(branch: string, title: string, body: string): Promise<string | undefined>;

  /**
   * Create a PR, wait for CI, and merge. Returns whether the PR was successfully merged.
   * Unlike createPullRequest (fire-and-forget), this awaits the full merge lifecycle.
   */
  createAndMergePullRequest?(branch: string, title: string, body: string): Promise<{ merged: boolean; prUrl?: string; error?: string }>;
}

/**
 * Tracker configuration — matches the TrackerConfigSchema shape.
 */
export interface TrackerConfig {
  kind: "github" | "notion" | "linear";
  token: string;
  active_states: string[];
  terminal_states: string[];
  poll_interval_ms: number;
  auto_close: boolean;
  repo?: string;
  labels?: string[];
  database_id?: string;
  property_map?: Record<string, string>;
  in_progress_label?: string;
  done_label?: string;
  // Linear-specific
  team_ids?: string[];
  project_id?: string;
  webhook_secret?: string;
  // Comment controls
  comments_enabled: boolean;
  comment_events: string[];
}
