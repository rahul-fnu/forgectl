import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerWebhookHandlers, webhookPayloadToTrackerIssue } from "../../src/github/webhooks.js";
import type { WebhookDeps } from "../../src/github/webhooks.js";

// Mock App with webhook handler registration
function createMockApp() {
  const handlers: Record<string, Function> = {};
  return {
    app: {
      webhooks: {
        on: vi.fn((event: string, handler: Function) => {
          handlers[event] = handler;
        }),
      },
      log: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    },
    handlers,
  };
}

function createMockOctokit(permission = "write") {
  return {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({
          data: { permission },
        }),
      },
      reactions: {
        createForIssueComment: vi.fn().mockResolvedValue({}),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({}),
      },
    },
  } as any;
}

function baseLabeledPayload(labelName: string) {
  return {
    action: "labeled",
    label: { name: labelName },
    issue: {
      number: 42,
      title: "Test issue",
      body: "Test body",
      state: "open",
      labels: [{ name: labelName }],
      assignees: [],
      user: { login: "testuser" },
      html_url: "https://github.com/owner/repo/issues/42",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    repository: {
      owner: { login: "owner" },
      name: "repo",
      full_name: "owner/repo",
    },
    installation: { id: 1 },
  };
}

function baseOpenedPayload(labels: string[]) {
  return {
    action: "opened",
    issue: {
      number: 42,
      title: "Test issue",
      body: "Test body",
      state: "open",
      labels: labels.map((name) => ({ name })),
      assignees: [],
      user: { login: "testuser" },
      html_url: "https://github.com/owner/repo/issues/42",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    repository: {
      owner: { login: "owner" },
      name: "repo",
      full_name: "owner/repo",
    },
    installation: { id: 1 },
  };
}

function baseCommentPayload(body: string, userType = "User", login = "testuser") {
  return {
    action: "created",
    comment: {
      id: 100,
      body,
      user: { login, type: userType },
    },
    issue: {
      number: 42,
      title: "Test issue",
      body: "Test body",
      state: "open",
      labels: [],
      assignees: [],
      user: { login: "testuser" },
      html_url: "https://github.com/owner/repo/issues/42",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    repository: {
      owner: { login: "owner" },
      name: "repo",
      full_name: "owner/repo",
    },
    installation: { id: 1 },
  };
}

describe("registerWebhookHandlers", () => {
  let mockApp: ReturnType<typeof createMockApp>;
  let deps: WebhookDeps;

  beforeEach(() => {
    mockApp = createMockApp();
    deps = {
      triggerLabel: "forgectl",
      onDispatch: vi.fn(),
      onCommand: vi.fn().mockResolvedValue(undefined),
      runRepo: {} as any,
    };
  });

  describe("issues.labeled", () => {
    it("calls dispatch callback when label matches", async () => {
      const octokit = createMockOctokit();
      registerWebhookHandlers(mockApp.app as any, deps);

      const handler = mockApp.handlers["issues.labeled"];
      await handler({ payload: baseLabeledPayload("forgectl"), octokit });

      expect(deps.onDispatch).toHaveBeenCalledTimes(1);
      const issue = (deps.onDispatch as any).mock.calls[0][0];
      expect(issue.id).toBe("42");
      expect(issue.title).toBe("Test issue");
    });

    it("ignores non-matching labels", async () => {
      const octokit = createMockOctokit();
      registerWebhookHandlers(mockApp.app as any, deps);

      const handler = mockApp.handlers["issues.labeled"];
      await handler({ payload: baseLabeledPayload("bug"), octokit });

      expect(deps.onDispatch).not.toHaveBeenCalled();
    });
  });

  describe("issues.opened", () => {
    it("calls dispatch callback when issue has matching label", async () => {
      const octokit = createMockOctokit();
      registerWebhookHandlers(mockApp.app as any, deps);

      const handler = mockApp.handlers["issues.opened"];
      await handler({ payload: baseOpenedPayload(["forgectl", "bug"]), octokit });

      expect(deps.onDispatch).toHaveBeenCalledTimes(1);
    });

    it("ignores issues without matching label", async () => {
      const octokit = createMockOctokit();
      registerWebhookHandlers(mockApp.app as any, deps);

      const handler = mockApp.handlers["issues.opened"];
      await handler({ payload: baseOpenedPayload(["bug", "enhancement"]), octokit });

      expect(deps.onDispatch).not.toHaveBeenCalled();
    });
  });

  describe("issue_comment.created", () => {
    it("calls command handler for valid command from authorized user", async () => {
      const octokit = createMockOctokit("write");
      registerWebhookHandlers(mockApp.app as any, deps);

      const handler = mockApp.handlers["issue_comment.created"];
      await handler({ payload: baseCommentPayload("/forgectl status"), octokit });

      expect(deps.onCommand).toHaveBeenCalledTimes(1);
      const cmd = (deps.onCommand as any).mock.calls[0][0];
      expect(cmd.command).toBe("status");
    });

    it("adds :x: reaction for unauthorized user", async () => {
      const octokit = createMockOctokit("read");
      registerWebhookHandlers(mockApp.app as any, deps);

      const handler = mockApp.handlers["issue_comment.created"];
      await handler({ payload: baseCommentPayload("/forgectl status"), octokit });

      expect(deps.onCommand).not.toHaveBeenCalled();
      expect(octokit.rest.reactions.createForIssueComment).toHaveBeenCalledWith(
        expect.objectContaining({ content: "-1" })
      );
    });

    it("ignores comments without /forgectl prefix", async () => {
      const octokit = createMockOctokit();
      registerWebhookHandlers(mockApp.app as any, deps);

      const handler = mockApp.handlers["issue_comment.created"];
      await handler({ payload: baseCommentPayload("just a comment"), octokit });

      expect(deps.onCommand).not.toHaveBeenCalled();
      expect(octokit.rest.reactions.createForIssueComment).not.toHaveBeenCalled();
    });

    it("adds :eyes: reaction on every valid command before processing", async () => {
      const octokit = createMockOctokit("admin");
      registerWebhookHandlers(mockApp.app as any, deps);

      const handler = mockApp.handlers["issue_comment.created"];
      await handler({ payload: baseCommentPayload("/forgectl run"), octokit });

      expect(octokit.rest.reactions.createForIssueComment).toHaveBeenCalledWith(
        expect.objectContaining({ content: "eyes" })
      );
      expect(deps.onCommand).toHaveBeenCalledTimes(1);
    });

    it("ignores comments from bots", async () => {
      const octokit = createMockOctokit();
      registerWebhookHandlers(mockApp.app as any, deps);

      const handler = mockApp.handlers["issue_comment.created"];
      await handler({
        payload: baseCommentPayload("/forgectl run", "Bot", "forgectl-bot"),
        octokit,
      });

      expect(deps.onCommand).not.toHaveBeenCalled();
    });
  });
});

describe("webhookPayloadToTrackerIssue", () => {
  it("converts GitHub issue payload to TrackerIssue", () => {
    const payload = {
      issue: {
        number: 42,
        title: "Test issue",
        body: "Test body",
        state: "open",
        labels: [{ name: "forgectl" }, { name: "bug" }],
        assignees: [{ login: "user1" }],
        user: { login: "author" },
        html_url: "https://github.com/owner/repo/issues/42",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      repository: {
        owner: { login: "owner" },
        name: "repo",
        full_name: "owner/repo",
      },
    };

    const issue = webhookPayloadToTrackerIssue(payload as any);
    expect(issue.id).toBe("42");
    expect(issue.identifier).toBe("owner/repo#42");
    expect(issue.title).toBe("Test issue");
    expect(issue.description).toBe("Test body");
    expect(issue.state).toBe("open");
    expect(issue.labels).toEqual(["forgectl", "bug"]);
    expect(issue.assignees).toEqual(["user1"]);
    expect(issue.url).toBe("https://github.com/owner/repo/issues/42");
  });
});
