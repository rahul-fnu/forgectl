import type { TrackerAdapter, TrackerConfig, TrackerIssue } from "./types.js";
import { resolveToken } from "./token.js";

const NOTION_API_BASE = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";
const MAX_REQUESTS_PER_SECOND = 3;

/** Default mapping from TrackerIssue field names to Notion property names. */
const DEFAULT_PROPERTY_MAP: Record<string, string> = {
  title: "Name",
  status: "Status",
  priority: "Priority",
  labels: "Tags",
  assignees: "Assignee",
  description: "Description",
};

/* ------------------------------------------------------------------
 * Rich-text helpers
 * ------------------------------------------------------------------ */

interface NotionAnnotations {
  bold: boolean;
  italic: boolean;
  code: boolean;
  strikethrough: boolean;
  underline: boolean;
}

interface NotionRichTextItem {
  text: { content: string };
  annotations?: NotionAnnotations;
}

/**
 * Convert a Notion rich_text array to a markdown string.
 * Applies markdown syntax for bold, italic, code, and strikethrough annotations.
 */
function richTextToMarkdown(items: NotionRichTextItem[]): string {
  if (!items || items.length === 0) return "";

  return items
    .map((item) => {
      let text = item.text.content;
      const ann = item.annotations;
      if (!ann) return text;

      if (ann.code) text = `\`${text}\``;
      if (ann.bold) text = `**${text}**`;
      if (ann.italic) text = `*${text}*`;
      if (ann.strikethrough) text = `~~${text}~~`;

      return text;
    })
    .join("");
}

/* ------------------------------------------------------------------
 * Property extraction
 * ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NotionProperty = any;

function extractProperty(
  prop: NotionProperty,
): string | string[] | null {
  if (!prop) return null;

  switch (prop.type) {
    case "title":
      return prop.title?.[0]?.plain_text ?? "";
    case "rich_text":
      return richTextToMarkdown(prop.rich_text ?? []);
    case "select":
      return prop.select?.name ?? null;
    case "multi_select":
      return (prop.multi_select ?? []).map((s: { name: string }) => s.name);
    case "people":
      return (prop.people ?? []).map((p: { name: string }) => p.name);
    case "url":
      return prop.url ?? null;
    case "relation":
      return (prop.relation ?? []).map((r: { id: string }) => r.id);
    case "created_time":
      return prop.created_time ?? null;
    case "last_edited_time":
      return prop.last_edited_time ?? null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------
 * Page normalization
 * ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizePage(page: any, propertyMap: Record<string, string>): TrackerIssue {
  const props = page.properties ?? {};

  const getProp = (field: string): NotionProperty => {
    const notionName = propertyMap[field];
    return notionName ? props[notionName] : undefined;
  };

  const title = extractProperty(getProp("title")) as string | null;
  const state = extractProperty(getProp("status")) as string | null;
  const priority = extractProperty(getProp("priority")) as string | null;
  const labels = (extractProperty(getProp("labels")) as string[] | null) ?? [];
  const assignees = (extractProperty(getProp("assignees")) as string[] | null) ?? [];
  const descriptionRaw = getProp("description");
  const description =
    descriptionRaw?.type === "rich_text"
      ? richTextToMarkdown(descriptionRaw.rich_text ?? [])
      : "";

  const pageId: string = page.id;

  return {
    id: pageId,
    identifier: pageId.slice(0, 8),
    title: title ?? "",
    description,
    state: state ?? "",
    priority,
    labels,
    assignees,
    url: `https://notion.so/${pageId.replace(/-/g, "")}`,
    created_at: page.created_time ?? "",
    updated_at: page.last_edited_time ?? "",
    blocked_by: [],
    metadata: {},
  };
}

/* ------------------------------------------------------------------
 * Notion adapter implementation
 * ------------------------------------------------------------------ */

class NotionAdapter implements TrackerAdapter {
  readonly kind = "notion";

  private readonly token: string;
  private readonly databaseId: string;
  private readonly propertyMap: Record<string, string>;
  private readonly activeStates: string[];
  private lastPollTime: string | null = null;
  private requestTimestamps: number[] = [];

  constructor(config: TrackerConfig) {
    if (!config.database_id) {
      throw new Error("Notion adapter requires database_id in config");
    }
    this.token = resolveToken(config.token);
    this.databaseId = config.database_id;
    this.propertyMap = { ...DEFAULT_PROPERTY_MAP, ...(config.property_map ?? {}) };
    this.activeStates = config.active_states;
  }

  /* ---- Throttle ---- */

  private async throttle(): Promise<void> {
    const now = Date.now();

    // Remove timestamps older than 1 second
    this.requestTimestamps = this.requestTimestamps.filter(
      (ts) => now - ts < 1000,
    );

    if (this.requestTimestamps.length >= MAX_REQUESTS_PER_SECOND) {
      const oldest = this.requestTimestamps[0];
      const waitMs = 1000 - (now - oldest);
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
      // Re-filter after waiting
      const afterWait = Date.now();
      this.requestTimestamps = this.requestTimestamps.filter(
        (ts) => afterWait - ts < 1000,
      );
    }

    this.requestTimestamps.push(Date.now());
  }

  /* ---- notionFetch ---- */

  private async notionFetch(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    await this.throttle();

    const opts: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(`${NOTION_API_BASE}${path}`, opts);

    // Handle 429 rate limit
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      // Retry once
      const retryRes = await fetch(`${NOTION_API_BASE}${path}`, opts);
      if (!retryRes.ok) {
        const errText = await retryRes.text();
        throw new Error(
          `Notion API error ${retryRes.status} on ${method} ${path}: ${errText}`,
        );
      }
      return retryRes.json();
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `Notion API error ${res.status} on ${method} ${path}: ${errText}`,
      );
    }

    return res.json();
  }

  /* ---- Query helpers ---- */

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async queryDatabase(filter?: unknown, sorts?: unknown[]): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allResults: any[] = [];
    let startCursor: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = {};
      if (filter) body.filter = filter;
      if (sorts) body.sorts = sorts;
      if (startCursor) body.start_cursor = startCursor;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await this.notionFetch(
        "POST",
        `/v1/databases/${this.databaseId}/query`,
        body,
      )) as any;

      allResults.push(...(result.results ?? []));

      if (result.has_more && result.next_cursor) {
        startCursor = result.next_cursor;
      } else {
        break;
      }
    }

    return allResults;
  }

  /* ---- TrackerAdapter methods ---- */

  async fetchCandidateIssues(): Promise<TrackerIssue[]> {
    const statusProp = this.propertyMap.status ?? "Status";

    // Build filter conditions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conditions: any[] = [];

    // Filter by active states if configured
    if (this.activeStates.length > 0) {
      const stateConditions = this.activeStates.map((state) => ({
        property: statusProp,
        select: { equals: state },
      }));
      if (stateConditions.length === 1) {
        conditions.push(stateConditions[0]);
      } else {
        conditions.push({ or: stateConditions });
      }
    }

    // Delta polling: filter by last_edited_time if we have a previous poll time
    if (this.lastPollTime) {
      conditions.push({
        timestamp: "last_edited_time",
        last_edited_time: { after: this.lastPollTime },
      });
    }

    let filter: unknown = undefined;
    if (conditions.length === 1) {
      filter = conditions[0];
    } else if (conditions.length > 1) {
      filter = { and: conditions };
    }

    const sorts = [{ timestamp: "last_edited_time", direction: "descending" }];

    const pages = await this.queryDatabase(filter, sorts);

    // Update poll time for next call
    this.lastPollTime = new Date().toISOString();

    return pages.map((page) => normalizePage(page, this.propertyMap));
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>> {
    const stateMap = new Map<string, string>();
    const statusProp = this.propertyMap.status ?? "Status";

    for (const id of ids) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page = (await this.notionFetch("GET", `/v1/pages/${id}`)) as any;
      const prop = page.properties?.[statusProp];
      const state = prop?.select?.name ?? "";
      stateMap.set(id, state);
    }

    return stateMap;
  }

  async fetchIssuesByStates(states: string[]): Promise<TrackerIssue[]> {
    const statusProp = this.propertyMap.status ?? "Status";

    const stateConditions = states.map((state) => ({
      property: statusProp,
      select: { equals: state },
    }));

    const filter =
      stateConditions.length === 1
        ? stateConditions[0]
        : { or: stateConditions };

    const pages = await this.queryDatabase(filter);
    return pages.map((page) => normalizePage(page, this.propertyMap));
  }

  async postComment(issueId: string, body: string): Promise<void> {
    await this.notionFetch("POST", "/v1/comments", {
      parent: { page_id: issueId },
      rich_text: [{ text: { content: body } }],
    });
  }

  async updateState(issueId: string, state: string): Promise<void> {
    const statusProp = this.propertyMap.status ?? "Status";
    await this.notionFetch("PATCH", `/v1/pages/${issueId}`, {
      properties: {
        [statusProp]: { select: { name: state } },
      },
    });
  }

  async updateLabels(
    issueId: string,
    add: string[],
    remove: string[],
  ): Promise<void> {
    const labelsProp = this.propertyMap.labels ?? "Tags";

    // Fetch current page to get existing labels
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = (await this.notionFetch("GET", `/v1/pages/${issueId}`)) as any;
    const currentLabels: string[] = (
      page.properties?.[labelsProp]?.multi_select ?? []
    ).map((s: { name: string }) => s.name);

    // Compute new set: remove specified, add new
    const removeSet = new Set(remove);
    const newLabels = currentLabels.filter((l) => !removeSet.has(l));
    for (const label of add) {
      if (!newLabels.includes(label)) {
        newLabels.push(label);
      }
    }

    await this.notionFetch("PATCH", `/v1/pages/${issueId}`, {
      properties: {
        [labelsProp]: {
          multi_select: newLabels.map((name) => ({ name })),
        },
      },
    });
  }
}

/**
 * Factory function for creating a Notion tracker adapter.
 * Validates config and resolves token.
 */
export function createNotionAdapter(config: TrackerConfig): TrackerAdapter {
  return new NotionAdapter(config);
}
