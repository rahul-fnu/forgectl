/**
 * Normalized issue model — tracker-agnostic representation of a work item.
 */
export interface TrackerIssue {
  id: string;
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
}

/**
 * Tracker configuration — matches the TrackerConfigSchema shape.
 */
export interface TrackerConfig {
  kind: "github" | "notion";
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
}
