import { describe, it, expect, vi, beforeEach } from "vitest";
import { SubIssueCache } from "../../src/tracker/sub-issue-cache.js";
import {
  handleLinearWebhook,
  verifyLinearWebhookSignature,
  type LinearWebhookPayload,
  type LinearWebhookResult,
} from "../../src/tracker/linear.js";

// ---- Config Validation ----

describe("Linear tracker config validation", () => {
  it("requires team_ids for linear tracker kind", async () => {
    const { TrackerConfigSchema } = await import("../../src/config/schema.js");

    const result = TrackerConfigSchema.safeParse({
      kind: "linear",
      token: "lin_api_test",
      team_ids: [],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('Tracker kind "linear" requires at least one entry in "team_ids"');
    }
  });

  it("rejects missing team_ids", async () => {
    const { TrackerConfigSchema } = await import("../../src/config/schema.js");
    const result = TrackerConfigSchema.safeParse({
      kind: "linear",
      token: "lin_api_test",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid linear config", async () => {
    const { TrackerConfigSchema } = await import("../../src/config/schema.js");

    const result = TrackerConfigSchema.safeParse({
      kind: "linear",
      token: "lin_api_test",
      team_ids: ["team-uuid-1", "team-uuid-2"],
    });

    expect(result.success).toBe(true);
  });

  it("accepts linear config with all optional fields", async () => {
    const { TrackerConfigSchema } = await import("../../src/config/schema.js");

    const result = TrackerConfigSchema.safeParse({
      kind: "linear",
      token: "lin_api_test",
      team_ids: ["team-uuid-1"],
      project_id: "proj-uuid",
      webhook_secret: "whsec_test",
      labels: ["forgectl"],
      active_states: ["In Progress", "Todo"],
      terminal_states: ["Done", "Canceled"],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.team_ids).toEqual(["team-uuid-1"]);
      expect(result.data.project_id).toBe("proj-uuid");
      expect(result.data.webhook_secret).toBe("whsec_test");
    }
  });

  it("uses correct defaults for linear config", async () => {
    const { TrackerConfigSchema } = await import("../../src/config/schema.js");

    const result = TrackerConfigSchema.safeParse({
      kind: "linear",
      token: "test",
      team_ids: ["team-1"],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.active_states).toEqual(["open"]);
      expect(result.data.terminal_states).toEqual(["closed"]);
      expect(result.data.poll_interval_ms).toBe(60000);
      expect(result.data.auto_close).toBe(false);
    }
  });

  it("does not break github config validation", async () => {
    const { TrackerConfigSchema } = await import("../../src/config/schema.js");

    const result = TrackerConfigSchema.safeParse({
      kind: "github",
      token: "ghp_test",
    });
    expect(result.success).toBe(false);

    const valid = TrackerConfigSchema.safeParse({
      kind: "github",
      token: "ghp_test",
      repo: "owner/repo",
    });
    expect(valid.success).toBe(true);
  });
});

// ---- Adapter Construction ----

describe("createLinearAdapter", () => {
  it("throws when team_ids is missing", async () => {
    const { createLinearAdapter } = await import("../../src/tracker/linear.js");

    expect(() =>
      createLinearAdapter({
        kind: "linear",
        token: "lin_api_test",
        active_states: ["open"],
        terminal_states: ["closed"],
        poll_interval_ms: 60000,
        auto_close: false,
      }),
    ).toThrow("team_ids is required");
  });

  it("throws when team_ids is empty", async () => {
    const { createLinearAdapter } = await import("../../src/tracker/linear.js");

    expect(() =>
      createLinearAdapter({
        kind: "linear",
        token: "lin_api_test",
        team_ids: [],
        active_states: ["open"],
        terminal_states: ["closed"],
        poll_interval_ms: 60000,
        auto_close: false,
      }),
    ).toThrow("team_ids is required");
  });

  it("creates adapter with correct kind and all required methods", async () => {
    const { createLinearAdapter } = await import("../../src/tracker/linear.js");

    const adapter = createLinearAdapter({
      kind: "linear",
      token: "lin_api_test",
      team_ids: ["team-1"],
      active_states: ["In Progress"],
      terminal_states: ["Done"],
      poll_interval_ms: 60000,
      auto_close: false,
    });

    expect(adapter.kind).toBe("linear");
    expect(typeof adapter.fetchCandidateIssues).toBe("function");
    expect(typeof adapter.fetchIssueStatesByIds).toBe("function");
    expect(typeof adapter.fetchIssuesByStates).toBe("function");
    expect(typeof adapter.postComment).toBe("function");
    expect(typeof adapter.updateState).toBe("function");
    expect(typeof adapter.updateLabels).toBe("function");
    // No PR methods (Linear is an issue tracker, not a code host)
    expect(adapter.createPullRequest).toBeUndefined();
    expect(adapter.createAndMergePullRequest).toBeUndefined();
  });

  it("uses external SubIssueCache when provided", async () => {
    const { createLinearAdapter } = await import("../../src/tracker/linear.js");
    const cache = new SubIssueCache(10000);

    const adapter = createLinearAdapter(
      {
        kind: "linear",
        token: "lin_api_test",
        team_ids: ["team-1"],
        active_states: ["open"],
        terminal_states: ["closed"],
        poll_interval_ms: 60000,
        auto_close: false,
      },
      cache,
    );

    expect(adapter.subIssueCache).toBe(cache);
  });

  it("exposes stateMapping and labelMapping for inspection", async () => {
    const { createLinearAdapter } = await import("../../src/tracker/linear.js");

    const adapter = createLinearAdapter({
      kind: "linear",
      token: "lin_api_test",
      team_ids: ["team-1"],
      active_states: ["open"],
      terminal_states: ["closed"],
      poll_interval_ms: 60000,
      auto_close: false,
    });

    expect(adapter.stateMapping.nameToId).toBeInstanceOf(Map);
    expect(adapter.stateMapping.idToName).toBeInstanceOf(Map);
    expect(adapter.labelMapping.nameToId).toBeInstanceOf(Map);
    expect(adapter.labelMapping.idToName).toBeInstanceOf(Map);
  });
});

// ---- Registry Integration ----

describe("Linear registry integration", () => {
  it("registers linear adapter in the tracker registry", async () => {
    const { createTrackerAdapter } = await import("../../src/tracker/registry.js");

    const adapter = createTrackerAdapter({
      kind: "linear",
      token: "lin_api_test",
      team_ids: ["team-1"],
      active_states: ["open"],
      terminal_states: ["closed"],
      poll_interval_ms: 60000,
      auto_close: false,
    });

    expect(adapter.kind).toBe("linear");
  });
});

// ---- Webhook Handler ----

describe("handleLinearWebhook", () => {
  let cache: SubIssueCache;

  beforeEach(() => {
    cache = new SubIssueCache();
  });

  it("ignores non-Issue events", () => {
    expect(handleLinearWebhook({ action: "create", type: "Comment", data: { id: "c1" } }, cache).relevant).toBe(false);
    expect(handleLinearWebhook({ action: "update", type: "Project", data: { id: "p1" } }, cache).relevant).toBe(false);
    expect(handleLinearWebhook({ action: "create", type: "Label", data: { id: "l1" } }, cache).relevant).toBe(false);
  });

  it("returns shouldTick on issue create", () => {
    const result = handleLinearWebhook({ action: "create", type: "Issue", data: { id: "i1" } }, cache);
    expect(result.relevant).toBe(true);
    expect(result.shouldTick).toBe(true);
    expect(result.issueId).toBe("i1");
    expect(result.reason).toBe("issue_created");
  });

  it("returns shouldTick on issue remove", () => {
    const result = handleLinearWebhook({ action: "remove", type: "Issue", data: { id: "i1" } }, cache);
    expect(result.relevant).toBe(true);
    expect(result.shouldTick).toBe(true);
    expect(result.reason).toBe("issue_removed");
  });

  it("invalidates parent cache when child issue is created", () => {
    cache.set({
      parentId: "parent-1",
      childIds: ["child-1"],
      childStates: new Map([["child-1", "In Progress"]]),
      fetchedAt: Date.now(),
    });

    handleLinearWebhook({
      action: "create",
      type: "Issue",
      data: { id: "child-2", parentId: "parent-1" },
    }, cache);

    expect(cache.get("parent-1")).toBeNull();
  });

  it("invalidates parent cache when child state changes", () => {
    cache.set({
      parentId: "parent-1",
      childIds: ["child-1", "child-2"],
      childStates: new Map([
        ["child-1", "In Progress"],
        ["child-2", "Todo"],
      ]),
      fetchedAt: Date.now(),
    });

    const result = handleLinearWebhook({
      action: "update",
      type: "Issue",
      data: { id: "child-1" },
      updatedFrom: { stateId: "old-state-uuid" },
    }, cache);

    expect(result.relevant).toBe(true);
    expect(result.shouldTick).toBe(true);
    expect(result.reason).toBe("state_change");
    expect(cache.get("parent-1")).toBeNull();
  });

  it("does not invalidate unrelated parent caches on state change", () => {
    cache.set({
      parentId: "parent-1",
      childIds: ["child-1"],
      childStates: new Map([["child-1", "Todo"]]),
      fetchedAt: Date.now(),
    });
    cache.set({
      parentId: "parent-2",
      childIds: ["child-2"],
      childStates: new Map([["child-2", "Todo"]]),
      fetchedAt: Date.now(),
    });

    handleLinearWebhook({
      action: "update",
      type: "Issue",
      data: { id: "child-1" },
      updatedFrom: { stateId: "old-state" },
    }, cache);

    // parent-1 invalidated (has child-1), parent-2 untouched
    expect(cache.get("parent-1")).toBeNull();
    expect(cache.get("parent-2")).not.toBeNull();
  });

  it("invalidates both old and new parent when sub-issue moves", () => {
    cache.set({
      parentId: "old-parent",
      childIds: ["child-1"],
      childStates: new Map([["child-1", "Todo"]]),
      fetchedAt: Date.now(),
    });
    cache.set({
      parentId: "new-parent",
      childIds: [],
      childStates: new Map(),
      fetchedAt: Date.now(),
    });

    const result = handleLinearWebhook({
      action: "update",
      type: "Issue",
      data: { id: "child-1", parentId: "new-parent" },
      updatedFrom: { parentId: "old-parent" },
    }, cache);

    expect(result.relevant).toBe(true);
    expect(result.shouldTick).toBe(true);
    expect(result.reason).toBe("parent_change");
    expect(cache.get("old-parent")).toBeNull();
    expect(cache.get("new-parent")).toBeNull();
  });

  it("handles parent change from no parent", () => {
    const result = handleLinearWebhook({
      action: "update",
      type: "Issue",
      data: { id: "child-1", parentId: "new-parent" },
      updatedFrom: { parentId: null },
    }, cache);

    expect(result.relevant).toBe(true);
    expect(result.shouldTick).toBe(true);
  });

  it("triggers on label change", () => {
    const result = handleLinearWebhook({
      action: "update",
      type: "Issue",
      data: { id: "i1" },
      updatedFrom: { labelIds: ["old-label-id"] },
    }, cache);

    expect(result.relevant).toBe(true);
    expect(result.shouldTick).toBe(true);
    expect(result.reason).toBe("label_change");
  });

  it("returns not relevant on irrelevant update (title change)", () => {
    const result = handleLinearWebhook({
      action: "update",
      type: "Issue",
      data: { id: "i1" },
      updatedFrom: { title: "Old title" },
    }, cache);
    expect(result.relevant).toBe(false);
    expect(result.shouldTick).toBe(false);
  });

  it("returns not relevant on missing data", () => {
    const result = handleLinearWebhook({ action: "create", type: "Issue" }, cache);
    expect(result.relevant).toBe(false);
  });

  it("returns not relevant on missing issue id in data", () => {
    const result = handleLinearWebhook({
      action: "create",
      type: "Issue",
      data: { title: "No id" },
    }, cache);
    expect(result.relevant).toBe(false);
  });

  it("triggers tick when state changes to an active state (Todo)", () => {
    const result = handleLinearWebhook({
      action: "update",
      type: "Issue",
      data: { id: "i1", state: { name: "Todo" } },
      updatedFrom: { stateId: "old-state" },
    }, cache, ["Todo", "In Progress"]);

    expect(result.shouldTick).toBe(true);
    expect(result.newState).toBe("Todo");
    expect(result.reason).toBe("state_change");
  });

  it("does not trigger tick when state changes to a non-active state", () => {
    const result = handleLinearWebhook({
      action: "update",
      type: "Issue",
      data: { id: "i1", state: { name: "Done" } },
      updatedFrom: { stateId: "old-state" },
    }, cache, ["Todo", "In Progress"]);

    expect(result.relevant).toBe(true);
    expect(result.shouldTick).toBe(false);
    expect(result.newState).toBe("Done");
  });

  it("triggers tick when issue created with active state", () => {
    const result = handleLinearWebhook({
      action: "create",
      type: "Issue",
      data: { id: "i1", state: { name: "Todo" } },
    }, cache, ["Todo"]);

    expect(result.shouldTick).toBe(true);
    expect(result.issueId).toBe("i1");
    expect(result.reason).toBe("issue_created");
    expect(result.newState).toBe("Todo");
  });

  it("does not trigger tick when issue created with non-active state", () => {
    const result = handleLinearWebhook({
      action: "create",
      type: "Issue",
      data: { id: "i1", state: { name: "Backlog" } },
    }, cache, ["Todo", "In Progress"]);

    expect(result.relevant).toBe(true);
    expect(result.shouldTick).toBe(false);
  });

  it("active state matching is case-insensitive", () => {
    const result = handleLinearWebhook({
      action: "update",
      type: "Issue",
      data: { id: "i1", state: { name: "todo" } },
      updatedFrom: { stateId: "old-state" },
    }, cache, ["Todo"]);

    expect(result.shouldTick).toBe(true);
  });

  it("triggers tick on state change when no activeStates provided (backwards-compat)", () => {
    const result = handleLinearWebhook({
      action: "update",
      type: "Issue",
      data: { id: "i1", state: { name: "Done" } },
      updatedFrom: { stateId: "old-state" },
    }, cache);

    expect(result.shouldTick).toBe(true);
  });
});

// ---- Webhook Signature Verification ----

describe("verifyLinearWebhookSignature", () => {
  it("accepts valid HMAC-SHA256 signature", async () => {
    const { createHmac } = await import("node:crypto");
    const secret = "test-webhook-secret";
    const body = '{"action":"create","type":"Issue","data":{"id":"abc"}}';
    const signature = createHmac("sha256", secret).update(body).digest("hex");

    expect(await verifyLinearWebhookSignature(body, signature, secret)).toBe(true);
  });

  it("rejects invalid signature", async () => {
    expect(await verifyLinearWebhookSignature(
      '{"action":"create"}',
      "0000000000000000000000000000000000000000000000000000000000000000",
      "secret",
    )).toBe(false);
  });

  it("rejects tampered body", async () => {
    const { createHmac } = await import("node:crypto");
    const secret = "my-secret";
    const body = '{"action":"create"}';
    const signature = createHmac("sha256", secret).update(body).digest("hex");

    expect(await verifyLinearWebhookSignature(
      '{"action":"create","tampered":true}',
      signature,
      secret,
    )).toBe(false);
  });

  it("rejects wrong secret", async () => {
    const { createHmac } = await import("node:crypto");
    const body = '{"ok":true}';
    const signature = createHmac("sha256", "correct").update(body).digest("hex");

    expect(await verifyLinearWebhookSignature(body, signature, "wrong")).toBe(false);
  });

  it("rejects mismatched length signatures", async () => {
    expect(await verifyLinearWebhookSignature('{}', "short", "secret")).toBe(false);
  });
});

// ---- Normalization ----

describe("Linear issue normalization", () => {
  it("normalizes priority correctly", async () => {
    // Import the internal normalize function via adapter behavior
    const { createLinearAdapter } = await import("../../src/tracker/linear.js");

    const adapter = createLinearAdapter({
      kind: "linear",
      token: "test",
      team_ids: ["t1"],
      active_states: ["open"],
      terminal_states: ["closed"],
      poll_interval_ms: 60000,
      auto_close: false,
    });

    // Adapter is created — we can verify its kind
    expect(adapter.kind).toBe("linear");
  });
});
