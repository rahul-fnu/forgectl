import { LinearClient } from "@linear/sdk";
import type { TrackerAdapter, TrackerConfig, TrackerIssue } from "./types.js";
import { resolveToken } from "./token.js";
import { SubIssueCache } from "./sub-issue-cache.js";
import { detectIssueCycles } from "./sub-issue-dag.js";

/**
 * State name → ID cache for Linear workflow states.
 * Linear uses UUIDs for states, but we expose human-readable names.
 */
interface StateMapping {
  nameToId: Map<string, string>;
  idToName: Map<string, string>;
}

/**
 * Label name → ID cache for Linear labels.
 */
interface LabelMapping {
  nameToId: Map<string, string>;
  idToName: Map<string, string>;
}

/**
 * Minimal issue data extracted from Linear SDK objects.
 * All fields are eagerly resolved (no lazy proxies).
 */
interface LinearIssueData {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  stateName: string;
  stateId: string;
  stateType: string;
  priority: number;
  priorityLabel: string;
  labelIds: string[];
  labelNames: string[];
  assigneeName: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  teamId: string;
  teamKey: string;
  projectId: string | null;
  parentId: string | null;
}

/**
 * Normalize a Linear issue to TrackerIssue.
 */
function normalizeLinearIssue(
  issue: LinearIssueData,
  childIds: string[],
  blockedByIds: string[],
): TrackerIssue {
  const allBlockers = [...new Set([...childIds, ...blockedByIds])];

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "",
    state: issue.stateName,
    priority: issue.priority > 0 ? String(issue.priority) : null,
    labels: issue.labelNames,
    assignees: issue.assigneeName ? [issue.assigneeName] : [],
    url: issue.url,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    blocked_by: allBlockers,
    metadata: {
      linearId: issue.id,
      teamId: issue.teamId,
      teamKey: issue.teamKey,
      projectId: issue.projectId,
      stateId: issue.stateId,
      stateType: issue.stateType,
      priorityLabel: issue.priorityLabel,
      parentId: issue.parentId,
    },
  };
}

/**
 * Eagerly resolve a Linear SDK Issue object into a plain data object.
 * The SDK returns proxy objects with lazy-loading getters — we await everything up front.
 */
async function resolveIssueData(
  issue: LinearSdkIssue,
  labelMapping: LabelMapping,
): Promise<LinearIssueData> {
  // state and team are LinearFetch getters (Promise-like)
  const [state, team, assignee] = await Promise.all([
    issue.state,
    issue.team,
    issue.assignee,
  ]);

  // labelIds is a direct string[] property — resolve names from cache
  const labelNames = issue.labelIds
    .map((id) => labelMapping.idToName.get(id))
    .filter((n): n is string => n != null);

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    stateName: state?.name ?? "Unknown",
    stateId: state?.id ?? "",
    stateType: state?.type ?? "",
    priority: issue.priority ?? 0,
    priorityLabel: issue.priorityLabel ?? "No priority",
    labelIds: issue.labelIds,
    labelNames,
    assigneeName: assignee?.displayName ?? assignee?.name ?? null,
    url: issue.url,
    createdAt: issue.createdAt instanceof Date ? issue.createdAt.toISOString() : String(issue.createdAt),
    updatedAt: issue.updatedAt instanceof Date ? issue.updatedAt.toISOString() : String(issue.updatedAt),
    teamId: team?.id ?? "",
    teamKey: team?.key ?? "",
    projectId: issue.projectId ?? null,
    parentId: issue.parentId ?? null,
  };
}

/**
 * Minimal type for a Linear SDK Issue object.
 * We use this instead of importing the class directly to simplify mocking.
 */
interface LinearSdkIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority: number;
  priorityLabel: string;
  url: string;
  createdAt: Date;
  updatedAt: Date;
  labelIds: string[];
  parentId?: string | null;
  projectId?: string | null;
  // Lazy-loading getters (return Promise-like LinearFetch)
  state: Promise<{ id: string; name: string; type: string } | undefined>;
  team: Promise<{ id: string; key: string } | undefined>;
  assignee: Promise<{ name: string; displayName?: string; email?: string } | undefined>;
  // Async connection methods
  children(vars?: unknown): Promise<{ nodes: LinearSdkIssue[] }>;
  labels(vars?: unknown): Promise<{ nodes: Array<{ id: string; name: string }> }>;
  relations(vars?: unknown): Promise<{ nodes: Array<{ type: string; relatedIssueId?: string }> }>;
  inverseRelations(vars?: unknown): Promise<{ nodes: Array<{ type: string; issueId?: string }> }>;
}

/**
 * Create a Linear Issues TrackerAdapter.
 *
 * Supports multi-team issue fetching, parent/child sub-issues,
 * blocking relations for DAG construction, and webhook-driven cache updates.
 */
export function createLinearAdapter(
  config: TrackerConfig,
  externalCache?: SubIssueCache,
): TrackerAdapter & { subIssueCache: SubIssueCache; client: LinearClient; stateMapping: StateMapping; labelMapping: LabelMapping } {
  if (!config.team_ids || config.team_ids.length === 0) {
    throw new Error("Linear adapter: team_ids is required with at least one team");
  }
  const teamIds = config.team_ids;

  const token = resolveToken(config.token);
  const client = new LinearClient({ apiKey: token });

  const subIssueCache = externalCache ?? new SubIssueCache();

  // Lazy-initialized state and label mappings (populated on first fetch)
  const stateMapping: StateMapping = { nameToId: new Map(), idToName: new Map() };
  const labelMapping: LabelMapping = { nameToId: new Map(), idToName: new Map() };
  let mappingsInitialized = false;

  /**
   * Initialize workflow state and label mappings for all configured teams.
   */
  async function initMappings(): Promise<void> {
    if (mappingsInitialized) return;

    for (const teamId of teamIds) {
      const team = await client.team(teamId);

      // Fetch all workflow states for this team
      const states = await team.states();
      for (const state of states.nodes) {
        stateMapping.nameToId.set(state.name.toLowerCase(), state.id);
        stateMapping.idToName.set(state.id, state.name);
        // Also index by type (backlog, unstarted, started, completed, canceled)
        // so users can use type names in active_states config
        if (!stateMapping.nameToId.has(state.type.toLowerCase())) {
          stateMapping.nameToId.set(state.type.toLowerCase(), state.id);
        }
      }

      // Fetch labels for this team
      const labels = await team.labels();
      for (const label of labels.nodes) {
        labelMapping.nameToId.set(label.name.toLowerCase(), label.id);
        labelMapping.idToName.set(label.id, label.name);
      }
    }

    mappingsInitialized = true;
  }

  /**
   * Resolve a state name (from config) to a Linear state ID.
   * Matches by name (case-insensitive) or falls back to UUID passthrough.
   */
  function resolveStateId(stateName: string): string | null {
    const lower = stateName.toLowerCase();
    return stateMapping.nameToId.get(lower) ?? (stateName.includes("-") ? stateName : null);
  }

  /**
   * Fetch issues from Linear filtered by state and labels, across all configured teams.
   */
  async function fetchFilteredIssues(stateNames: string[]): Promise<LinearIssueData[]> {
    await initMappings();

    const results: LinearIssueData[] = [];

    for (const teamId of teamIds) {
      // Resolve state names to IDs
      const stateIds: string[] = [];
      for (const name of stateNames) {
        const id = resolveStateId(name);
        if (id) stateIds.push(id);
      }

      // Build GraphQL filter
      const filter: Record<string, unknown> = {
        team: { id: { eq: teamId } },
      };

      if (stateIds.length > 0) {
        filter.state = { id: { in: stateIds } };
      }

      // Label filter from config
      const labelFilter = config.labels ?? [];
      if (labelFilter.length > 0) {
        const labelIds: string[] = [];
        for (const name of labelFilter) {
          const id = labelMapping.nameToId.get(name.toLowerCase());
          if (id) labelIds.push(id);
        }
        if (labelIds.length > 0) {
          filter.labels = { some: { id: { in: labelIds } } };
        }
      }

      // Project filter
      if (config.project_id) {
        filter.project = { id: { eq: config.project_id } };
      }

      // Paginate through all matching issues
      let hasMore = true;
      let cursor: string | undefined;

      while (hasMore) {
        const connection = await client.issues({
          filter,
          first: 50,
          after: cursor,
          includeArchived: false,
        });

        // Resolve all issues in parallel for this page
        const pageData = await Promise.all(
          connection.nodes.map((issue) =>
            resolveIssueData(issue as unknown as LinearSdkIssue, labelMapping),
          ),
        );
        results.push(...pageData);

        hasMore = connection.pageInfo.hasNextPage;
        cursor = connection.pageInfo.endCursor ?? undefined;
      }
    }

    return results;
  }

  /**
   * Fetch children (sub-issues) of a given issue.
   */
  async function fetchChildren(issueId: string): Promise<{ id: string; state: string }[]> {
    const issue = await client.issue(issueId);
    const children = await (issue as unknown as LinearSdkIssue).children();
    const childResults: { id: string; state: string }[] = [];

    for (const child of children.nodes) {
      const state = await child.state;
      childResults.push({
        id: child.id,
        state: state?.name ?? "Unknown",
      });
    }

    return childResults;
  }

  /**
   * Fetch issues that block a given issue (via IssueRelation).
   * Uses direct ID properties to avoid extra API calls.
   */
  async function fetchBlockingRelations(issueId: string): Promise<string[]> {
    const issue = await client.issue(issueId);
    const sdkIssue = issue as unknown as LinearSdkIssue;
    const blockers: string[] = [];

    // Forward relations: if this issue has type "blocks", the relatedIssue is downstream
    // (this issue blocks it) — NOT a blocker of this issue. Skip forward "blocks".

    // Inverse relations: other issues that block this one.
    // If another issue has a "blocks" relation pointing at this issue,
    // that other issue appears here — it IS a blocker.
    const inverseRelations = await sdkIssue.inverseRelations();
    for (const rel of inverseRelations.nodes) {
      if (rel.type === "blocks" && rel.issueId) {
        blockers.push(rel.issueId);
      }
    }

    return blockers;
  }

  const adapter: TrackerAdapter & { subIssueCache: SubIssueCache; client: LinearClient; stateMapping: StateMapping; labelMapping: LabelMapping } = {
    kind: "linear",
    subIssueCache,
    client,
    stateMapping,
    labelMapping,

    async fetchCandidateIssues(): Promise<TrackerIssue[]> {
      const activeStates = config.active_states;
      const issueDataList = await fetchFilteredIssues(activeStates);

      // Enrich with sub-issues and blocking relations
      const enriched: TrackerIssue[] = [];
      const candidateIds = new Set<string>(issueDataList.map((i) => i.id));

      for (const issueData of issueDataList) {
        // Check sub-issue cache first
        let childIds: string[] = [];
        const cached = subIssueCache.get(issueData.id);

        if (cached) {
          childIds = cached.childIds;
        } else {
          // Fetch children
          const children = await fetchChildren(issueData.id);
          childIds = children.map((c) => c.id);
          const childStates = new Map(children.map((c) => [c.id, c.state]));

          subIssueCache.set({
            parentId: issueData.id,
            childIds,
            childStates,
            fetchedAt: Date.now(),
          });
        }

        // Fetch blocking relations
        const blockedByIds = await fetchBlockingRelations(issueData.id);

        const normalized = normalizeLinearIssue(issueData, childIds, blockedByIds);
        enriched.push(normalized);

        // Auto-discover children not already in candidate set.
        // Skip children in terminal states (Done, Canceled, etc.)
        const terminalTypes = new Set(["completed", "canceled"]);
        for (const childId of childIds) {
          if (!candidateIds.has(childId)) {
            candidateIds.add(childId);
            try {
              const childIssue = await client.issue(childId);
              const childData = await resolveIssueData(
                childIssue as unknown as LinearSdkIssue,
                labelMapping,
              );
              // Skip children in terminal states — they're already done
              if (terminalTypes.has(childData.stateType)) continue;
              const childNormalized = normalizeLinearIssue(childData, [], []);
              enriched.push(childNormalized);
            } catch {
              // Child issue may be archived or inaccessible
            }
          }
        }
      }

      // Cycle detection
      const cycleError = detectIssueCycles(
        enriched.map((i) => ({ id: i.id, blocked_by: i.blocked_by })),
      );
      if (cycleError) {
        console.warn(`[forgectl] Linear sub-issue dependency cycle detected: ${cycleError}`);
      }

      return enriched;
    },

    async fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>> {
      await initMappings();
      const stateMap = new Map<string, string>();

      for (const id of ids) {
        try {
          const issue = await client.issue(id);
          const state = await (issue as unknown as LinearSdkIssue).state;
          stateMap.set(id, state?.name ?? "Unknown");
        } catch {
          stateMap.set(id, "unknown");
        }
      }

      return stateMap;
    },

    async fetchIssuesByStates(states: string[]): Promise<TrackerIssue[]> {
      const issueDataList = await fetchFilteredIssues(states);
      return issueDataList.map((data) => normalizeLinearIssue(data, [], []));
    },

    async postComment(issueId: string, body: string): Promise<void> {
      await client.createComment({ issueId, body });
    },

    async updateState(issueId: string, state: string): Promise<void> {
      await initMappings();

      const stateId = resolveStateId(state);
      if (!stateId) {
        throw new Error(
          `Linear: unknown state "${state}". Available: ${[...stateMapping.nameToId.keys()].join(", ")}`,
        );
      }

      await client.updateIssue(issueId, { stateId });
    },

    async createIssue(title: string, description: string, labels?: string[]): Promise<string> {
      await initMappings();
      const teamId = teamIds[0];

      const labelIds: string[] = [];
      if (labels) {
        for (const name of labels) {
          const id = labelMapping.nameToId.get(name.toLowerCase());
          if (id) labelIds.push(id);
        }
      }

      const result = await client.createIssue({
        teamId,
        title,
        description,
        ...(labelIds.length > 0 ? { labelIds } : {}),
        ...(config.project_id ? { projectId: config.project_id } : {}),
      });
      const issue = await result.issue;
      return issue?.identifier ?? result.lastSyncId.toString();
    },

    async updateLabels(
      issueId: string,
      add: string[],
      remove: string[],
    ): Promise<void> {
      await initMappings();

      // Get current label IDs from the issue
      const issue = await client.issue(issueId);
      const currentIds = new Set((issue as unknown as LinearSdkIssue).labelIds);

      for (const name of add) {
        const id = labelMapping.nameToId.get(name.toLowerCase());
        if (id) currentIds.add(id);
      }

      for (const name of remove) {
        const id = labelMapping.nameToId.get(name.toLowerCase());
        if (id) currentIds.delete(id);
      }

      await client.updateIssue(issueId, { labelIds: [...currentIds] });
    },
  };

  return adapter;
}

/**
 * Handle a Linear webhook payload.
 * Updates the SubIssueCache when parent/child relationships change.
 * Returns true if the event is relevant and should trigger an orchestrator tick.
 */
export function handleLinearWebhook(
  payload: LinearWebhookPayload,
  subIssueCache: SubIssueCache,
): boolean {
  const { action, type } = payload;

  if (type !== "Issue") return false;

  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return false;

  const issueId = data.id as string | undefined;
  if (!issueId) return false;

  if (action === "update") {
    const updatedFrom = payload.updatedFrom as Record<string, unknown> | undefined;

    // State change — invalidate parent cache entries containing this child
    if (updatedFrom?.stateId) {
      for (const entry of subIssueCache.getAllEntries()) {
        if (entry.childIds.includes(issueId)) {
          subIssueCache.invalidate(entry.parentId);
        }
      }
      return true;
    }

    // Parent relationship changed — invalidate both old and new parent
    if (updatedFrom && "parentId" in updatedFrom) {
      const oldParentId = updatedFrom.parentId as string | undefined;
      const newParentId = data.parentId as string | undefined;
      if (oldParentId) subIssueCache.invalidate(oldParentId);
      if (newParentId) subIssueCache.invalidate(newParentId);
      return true;
    }

    // Label change — may affect filtering
    if (updatedFrom?.labelIds) {
      return true;
    }
  }

  // New or deleted issue — always trigger refresh
  if (action === "create" || action === "remove") {
    const parentId = data.parentId as string | undefined;
    if (parentId) {
      subIssueCache.invalidate(parentId);
    }
    return true;
  }

  return false;
}

/**
 * Verify a Linear webhook signature using HMAC-SHA256.
 */
export async function verifyLinearWebhookSignature(
  body: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const expected = createHmac("sha256", secret).update(body).digest("hex");

  if (expected.length !== signature.length) return false;

  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Minimal webhook payload type for our handler.
 */
export interface LinearWebhookPayload {
  action: string;
  type: string;
  data?: Record<string, unknown>;
  updatedFrom?: Record<string, unknown>;
  url?: string;
  createdAt?: string;
  organizationId?: string;
  webhookTimestamp?: number;
}
