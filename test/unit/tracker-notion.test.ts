import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TrackerConfig } from "../../src/tracker/types.js";

// We'll import the factory and internals
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createNotionAdapter: any;

// Mock fetch globally
const mockFetch = vi.fn();

beforeEach(() => {
  process.env.TEST_NOTION_TOKEN = "ntn_test";
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  delete process.env.TEST_NOTION_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    kind: "notion",
    token: "$TEST_NOTION_TOKEN",
    active_states: ["To Do", "In Progress"],
    terminal_states: ["Done"],
    poll_interval_ms: 60000,
    auto_close: false,
    database_id: "db-123-abc",
    ...overrides,
  };
}

function makeNotionPage(overrides: Record<string, unknown> = {}) {
  return {
    id: "page-1111-2222-3333-444444444444",
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-01-15T12:00:00.000Z",
    properties: {
      Name: {
        type: "title",
        title: [{ plain_text: "Fix the bug", text: { content: "Fix the bug" } }],
      },
      Status: {
        type: "select",
        select: { name: "To Do" },
      },
      Priority: {
        type: "select",
        select: { name: "High" },
      },
      Tags: {
        type: "multi_select",
        multi_select: [{ name: "bug" }, { name: "urgent" }],
      },
      Assignee: {
        type: "people",
        people: [{ name: "Alice" }],
      },
      Description: {
        type: "rich_text",
        rich_text: [
          {
            text: { content: "Something is broken" },
            annotations: {
              bold: false,
              italic: false,
              code: false,
              strikethrough: false,
              underline: false,
            },
          },
        ],
      },
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] || null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe("Notion TrackerAdapter", () => {
  beforeEach(async () => {
    const mod = await import("../../src/tracker/notion.js");
    createNotionAdapter = mod.createNotionAdapter;
  });

  describe("factory", () => {
    it("throws on missing database_id", () => {
      const config = makeConfig({ database_id: undefined });
      expect(() => createNotionAdapter(config)).toThrow(/database_id/);
    });

    it("creates adapter with valid config", () => {
      const adapter = createNotionAdapter(makeConfig());
      expect(adapter.kind).toBe("notion");
    });
  });

  describe("fetchCandidateIssues", () => {
    it("queries database and returns normalized issues", async () => {
      const page = makeNotionPage();
      mockFetch.mockReturnValueOnce(
        jsonResponse({ results: [page], has_more: false, next_cursor: null }),
      );

      const adapter = createNotionAdapter(makeConfig());
      const issues = await adapter.fetchCandidateIssues();

      expect(issues).toHaveLength(1);
      expect(issues[0].title).toBe("Fix the bug");
      expect(issues[0].state).toBe("To Do");
      expect(issues[0].priority).toBe("High");
      expect(issues[0].labels).toEqual(["bug", "urgent"]);
      expect(issues[0].assignees).toEqual(["Alice"]);
      expect(issues[0].description).toBe("Something is broken");
      expect(issues[0].url).toContain("notion.so/");
      expect(issues[0].id).toBe(page.id);

      // Verify the fetch was called with correct URL and auth
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/v1/databases/db-123-abc/query");
      expect(opts.headers["Authorization"]).toBe("Bearer ntn_test");
      expect(opts.headers["Notion-Version"]).toBe("2022-06-28");
    });

    it("paginates via start_cursor/has_more", async () => {
      const page1 = makeNotionPage({ id: "page-aaaa" });
      const page2 = makeNotionPage({ id: "page-bbbb" });

      mockFetch
        .mockReturnValueOnce(
          jsonResponse({ results: [page1], has_more: true, next_cursor: "cursor-1" }),
        )
        .mockReturnValueOnce(
          jsonResponse({ results: [page2], has_more: false, next_cursor: null }),
        );

      const adapter = createNotionAdapter(makeConfig());
      const issues = await adapter.fetchCandidateIssues();

      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe("page-aaaa");
      expect(issues[1].id).toBe("page-bbbb");

      // Second call should include start_cursor
      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(secondBody.start_cursor).toBe("cursor-1");
    });

    it("applies delta polling filter on subsequent calls", async () => {
      mockFetch.mockReturnValue(
        jsonResponse({ results: [], has_more: false, next_cursor: null }),
      );

      const adapter = createNotionAdapter(makeConfig());

      // First call: no last_edited_time filter
      await adapter.fetchCandidateIssues();
      const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      // No last_edited_time filter on first call
      expect(firstBody.filter).toBeDefined();

      // Second call: should include last_edited_time filter
      mockFetch.mockClear();
      mockFetch.mockReturnValue(
        jsonResponse({ results: [], has_more: false, next_cursor: null }),
      );
      await adapter.fetchCandidateIssues();
      const secondBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(JSON.stringify(secondBody)).toContain("last_edited_time");
    });
  });

  describe("property extraction", () => {
    it("extracts title property", async () => {
      const page = makeNotionPage();
      mockFetch.mockReturnValueOnce(
        jsonResponse({ results: [page], has_more: false, next_cursor: null }),
      );

      const adapter = createNotionAdapter(makeConfig());
      const issues = await adapter.fetchCandidateIssues();
      expect(issues[0].title).toBe("Fix the bug");
    });

    it("extracts select property for state/priority", async () => {
      const page = makeNotionPage();
      mockFetch.mockReturnValueOnce(
        jsonResponse({ results: [page], has_more: false, next_cursor: null }),
      );

      const adapter = createNotionAdapter(makeConfig());
      const issues = await adapter.fetchCandidateIssues();
      expect(issues[0].state).toBe("To Do");
      expect(issues[0].priority).toBe("High");
    });

    it("extracts multi_select property for labels", async () => {
      const page = makeNotionPage();
      mockFetch.mockReturnValueOnce(
        jsonResponse({ results: [page], has_more: false, next_cursor: null }),
      );

      const adapter = createNotionAdapter(makeConfig());
      const issues = await adapter.fetchCandidateIssues();
      expect(issues[0].labels).toEqual(["bug", "urgent"]);
    });

    it("extracts people property for assignees", async () => {
      const page = makeNotionPage();
      mockFetch.mockReturnValueOnce(
        jsonResponse({ results: [page], has_more: false, next_cursor: null }),
      );

      const adapter = createNotionAdapter(makeConfig());
      const issues = await adapter.fetchCandidateIssues();
      expect(issues[0].assignees).toEqual(["Alice"]);
    });

    it("handles null/missing select gracefully", async () => {
      const page = makeNotionPage();
      // @ts-expect-error - deliberately null for test
      page.properties.Priority = { type: "select", select: null };
      mockFetch.mockReturnValueOnce(
        jsonResponse({ results: [page], has_more: false, next_cursor: null }),
      );

      const adapter = createNotionAdapter(makeConfig());
      const issues = await adapter.fetchCandidateIssues();
      expect(issues[0].priority).toBeNull();
    });

    it("uses custom property_map", async () => {
      const page = makeNotionPage();
      page.properties["Task Name"] = page.properties.Name;
      page.properties["State"] = page.properties.Status;
      delete (page.properties as Record<string, unknown>).Name;
      delete (page.properties as Record<string, unknown>).Status;

      mockFetch.mockReturnValueOnce(
        jsonResponse({ results: [page], has_more: false, next_cursor: null }),
      );

      const adapter = createNotionAdapter(
        makeConfig({
          property_map: { title: "Task Name", status: "State" },
        }),
      );
      const issues = await adapter.fetchCandidateIssues();
      expect(issues[0].title).toBe("Fix the bug");
      expect(issues[0].state).toBe("To Do");
    });
  });

  describe("richTextToMarkdown", () => {
    it("converts plain text", async () => {
      const page = makeNotionPage();
      page.properties.Description = {
        type: "rich_text",
        rich_text: [
          {
            text: { content: "Hello world" },
            annotations: {
              bold: false,
              italic: false,
              code: false,
              strikethrough: false,
              underline: false,
            },
          },
        ],
      };
      mockFetch.mockReturnValueOnce(
        jsonResponse({ results: [page], has_more: false, next_cursor: null }),
      );

      const adapter = createNotionAdapter(makeConfig());
      const issues = await adapter.fetchCandidateIssues();
      expect(issues[0].description).toBe("Hello world");
    });

    it("converts bold text", async () => {
      const page = makeNotionPage();
      page.properties.Description = {
        type: "rich_text",
        rich_text: [
          {
            text: { content: "important" },
            annotations: {
              bold: true,
              italic: false,
              code: false,
              strikethrough: false,
              underline: false,
            },
          },
        ],
      };
      mockFetch.mockReturnValueOnce(
        jsonResponse({ results: [page], has_more: false, next_cursor: null }),
      );

      const adapter = createNotionAdapter(makeConfig());
      const issues = await adapter.fetchCandidateIssues();
      expect(issues[0].description).toBe("**important**");
    });

    it("converts italic text", async () => {
      const page = makeNotionPage();
      page.properties.Description = {
        type: "rich_text",
        rich_text: [
          {
            text: { content: "emphasis" },
            annotations: {
              bold: false,
              italic: true,
              code: false,
              strikethrough: false,
              underline: false,
            },
          },
        ],
      };
      mockFetch.mockReturnValueOnce(
        jsonResponse({ results: [page], has_more: false, next_cursor: null }),
      );

      const adapter = createNotionAdapter(makeConfig());
      const issues = await adapter.fetchCandidateIssues();
      expect(issues[0].description).toBe("*emphasis*");
    });

    it("converts code text", async () => {
      const page = makeNotionPage();
      page.properties.Description = {
        type: "rich_text",
        rich_text: [
          {
            text: { content: "const x = 1" },
            annotations: {
              bold: false,
              italic: false,
              code: true,
              strikethrough: false,
              underline: false,
            },
          },
        ],
      };
      mockFetch.mockReturnValueOnce(
        jsonResponse({ results: [page], has_more: false, next_cursor: null }),
      );

      const adapter = createNotionAdapter(makeConfig());
      const issues = await adapter.fetchCandidateIssues();
      expect(issues[0].description).toBe("`const x = 1`");
    });

    it("converts strikethrough text", async () => {
      const page = makeNotionPage();
      page.properties.Description = {
        type: "rich_text",
        rich_text: [
          {
            text: { content: "removed" },
            annotations: {
              bold: false,
              italic: false,
              code: false,
              strikethrough: true,
              underline: false,
            },
          },
        ],
      };
      mockFetch.mockReturnValueOnce(
        jsonResponse({ results: [page], has_more: false, next_cursor: null }),
      );

      const adapter = createNotionAdapter(makeConfig());
      const issues = await adapter.fetchCandidateIssues();
      expect(issues[0].description).toBe("~~removed~~");
    });

    it("handles mixed annotations", async () => {
      const page = makeNotionPage();
      page.properties.Description = {
        type: "rich_text",
        rich_text: [
          {
            text: { content: "normal " },
            annotations: {
              bold: false,
              italic: false,
              code: false,
              strikethrough: false,
              underline: false,
            },
          },
          {
            text: { content: "bold" },
            annotations: {
              bold: true,
              italic: false,
              code: false,
              strikethrough: false,
              underline: false,
            },
          },
          {
            text: { content: " and " },
            annotations: {
              bold: false,
              italic: false,
              code: false,
              strikethrough: false,
              underline: false,
            },
          },
          {
            text: { content: "italic" },
            annotations: {
              bold: false,
              italic: true,
              code: false,
              strikethrough: false,
              underline: false,
            },
          },
        ],
      };
      mockFetch.mockReturnValueOnce(
        jsonResponse({ results: [page], has_more: false, next_cursor: null }),
      );

      const adapter = createNotionAdapter(makeConfig());
      const issues = await adapter.fetchCandidateIssues();
      expect(issues[0].description).toBe("normal **bold** and *italic*");
    });
  });

  describe("fetchIssueStatesByIds", () => {
    it("fetches pages and returns state map", async () => {
      const page1 = makeNotionPage({ id: "id-1" });
      const page2 = makeNotionPage({ id: "id-2" });
      // @ts-expect-error - override for test
      page2.properties.Status = { type: "select", select: { name: "In Progress" } };

      mockFetch
        .mockReturnValueOnce(jsonResponse(page1))
        .mockReturnValueOnce(jsonResponse(page2));

      const adapter = createNotionAdapter(makeConfig());
      const states = await adapter.fetchIssueStatesByIds(["id-1", "id-2"]);

      expect(states.get("id-1")).toBe("To Do");
      expect(states.get("id-2")).toBe("In Progress");
    });
  });

  describe("fetchIssuesByStates", () => {
    it("queries database with state filter", async () => {
      const page = makeNotionPage();
      mockFetch.mockReturnValueOnce(
        jsonResponse({ results: [page], has_more: false, next_cursor: null }),
      );

      const adapter = createNotionAdapter(makeConfig());
      const issues = await adapter.fetchIssuesByStates(["To Do"]);

      expect(issues).toHaveLength(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(JSON.stringify(body.filter)).toContain("To Do");
    });
  });

  describe("postComment", () => {
    it("posts comment with correct body", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ id: "comment-1" }));

      const adapter = createNotionAdapter(makeConfig());
      await adapter.postComment("page-id-123", "This is a comment");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/v1/comments");
      const body = JSON.parse(opts.body);
      expect(body.parent.page_id).toBe("page-id-123");
      expect(body.rich_text[0].text.content).toBe("This is a comment");
    });
  });

  describe("updateState", () => {
    it("patches page with new status", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ id: "page-1" }));

      const adapter = createNotionAdapter(makeConfig());
      await adapter.updateState("page-1", "Done");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/v1/pages/page-1");
      expect(opts.method).toBe("PATCH");
      const body = JSON.parse(opts.body);
      expect(body.properties.Status.select.name).toBe("Done");
    });
  });

  describe("updateLabels", () => {
    it("adds and removes labels", async () => {
      // First GET to read current labels
      const currentPage = makeNotionPage();
      mockFetch
        .mockReturnValueOnce(jsonResponse(currentPage)) // GET current page
        .mockReturnValueOnce(jsonResponse({ id: "page-1" })); // PATCH update

      const adapter = createNotionAdapter(makeConfig());
      await adapter.updateLabels(
        currentPage.id,
        ["new-label"],
        ["bug"],
      );

      // Should have fetched current page first
      const [getUrl] = mockFetch.mock.calls[0];
      expect(getUrl).toContain(`/v1/pages/${currentPage.id}`);

      // Then patched with updated labels
      const [, patchOpts] = mockFetch.mock.calls[1];
      const body = JSON.parse(patchOpts.body);
      const labelNames = body.properties.Tags.multi_select.map(
        (l: { name: string }) => l.name,
      );
      expect(labelNames).toContain("urgent"); // kept
      expect(labelNames).toContain("new-label"); // added
      expect(labelNames).not.toContain("bug"); // removed
    });
  });

  describe("throttle", () => {
    it("delays when exceeding 3 requests/second", async () => {
      // Mock Date.now to control timing
      const realDateNow = Date.now;
      let now = 1000000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      // Mock setTimeout to track delays
      const realSetTimeout = globalThis.setTimeout;
      const delays: number[] = [];
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
        delays.push(ms);
        now += ms; // advance mock time
        fn(); // execute immediately
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);

      try {
        const adapter = createNotionAdapter(makeConfig());

        // Make 4 rapid requests (each returns immediately)
        for (let i = 0; i < 4; i++) {
          mockFetch.mockReturnValueOnce(
            jsonResponse({ results: [], has_more: false, next_cursor: null }),
          );
        }

        await adapter.fetchCandidateIssues(); // req 1
        // Reset mock for individual fetches
        mockFetch.mockReturnValue(jsonResponse({ id: "page" }));
        await adapter.postComment("p1", "c1"); // req 2
        await adapter.postComment("p2", "c2"); // req 3
        await adapter.postComment("p3", "c3"); // req 4 - should trigger throttle delay

        // At least one delay should have been > 0 for throttle
        expect(delays.some((d) => d > 0)).toBe(true);
      } finally {
        Date.now = realDateNow;
        globalThis.setTimeout = realSetTimeout;
      }
    });
  });

  describe("429 retry", () => {
    it("retries after Retry-After delay on 429", async () => {
      const realSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);

      try {
        // First call: 429, second: success
        mockFetch
          .mockReturnValueOnce(
            jsonResponse({ message: "rate limited" }, 429, { "retry-after": "1" }),
          )
          .mockReturnValueOnce(
            jsonResponse({ results: [], has_more: false, next_cursor: null }),
          );

        const adapter = createNotionAdapter(makeConfig());
        const issues = await adapter.fetchCandidateIssues();

        expect(issues).toHaveLength(0);
        expect(mockFetch).toHaveBeenCalledTimes(2); // original + retry
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
    });
  });

  describe("page URL generation", () => {
    it("generates correct notion.so URL with dashes removed", async () => {
      const page = makeNotionPage({ id: "abcd-1234-efgh-5678" });
      mockFetch.mockReturnValueOnce(
        jsonResponse({ results: [page], has_more: false, next_cursor: null }),
      );

      const adapter = createNotionAdapter(makeConfig());
      const issues = await adapter.fetchCandidateIssues();

      expect(issues[0].url).toBe("https://notion.so/abcd1234efgh5678");
    });
  });
});
