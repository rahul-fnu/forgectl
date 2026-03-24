import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerWebhookHandlers } from "../../src/github/webhooks.js";
import type { WebhookDeps } from "../../src/github/webhooks.js";

vi.mock("../../src/github/ci-logs.js", () => ({
  fetchCIErrorLog: vi.fn().mockResolvedValue("error[E0308]: mismatched types\n  --> src/main.rs:10:5"),
}));

vi.mock("../../src/github/permissions.js", () => ({
  hasWriteAccess: vi.fn().mockResolvedValue(true),
}));

function createMockApp() {
  const handlers: Record<string, Function> = {};
  return {
    app: {
      webhooks: {
        on: vi.fn((event: string, handler: Function) => {
          handlers[event] = handler;
        }),
      },
    },
    handlers,
  };
}

function baseDeps(overrides?: Partial<WebhookDeps>): WebhookDeps {
  return {
    triggerLabel: "forgectl",
    onDispatch: vi.fn(),
    onCommand: vi.fn(),
    runRepo: {
      insert: vi.fn(),
      findById: vi.fn(),
      findByStatus: vi.fn().mockReturnValue([]),
      update: vi.fn(),
      findAll: vi.fn().mockReturnValue([]),
      deleteOlderThan: vi.fn(),
    } as any,
    ...overrides,
  };
}

function checkSuitePayload(overrides?: {
  conclusion?: string;
  headBranch?: string;
  headSha?: string;
}) {
  return {
    check_suite: {
      conclusion: overrides?.conclusion ?? "failure",
      head_branch: overrides?.headBranch ?? "forge/fix-build",
      head_sha: overrides?.headSha ?? "abc12345deadbeef",
    },
    repository: {
      owner: { login: "owner" },
      name: "repo",
      full_name: "owner/repo",
    },
  };
}

describe("CI failure dispatch webhook", () => {
  let mockApp: ReturnType<typeof createMockApp>;
  let deps: WebhookDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApp = createMockApp();
    deps = baseDeps();
    registerWebhookHandlers(mockApp.app as any, deps);
  });

  it("registers check_suite.completed handler", () => {
    expect(mockApp.handlers["check_suite.completed"]).toBeDefined();
  });

  it("dispatches on forge/* branch failure", async () => {
    const handler = mockApp.handlers["check_suite.completed"];
    const octokit = { auth: { token: "test-token" } };
    await handler({ payload: checkSuitePayload(), octokit });

    expect(deps.onDispatch).toHaveBeenCalledTimes(1);
    const issue = (deps.onDispatch as any).mock.calls[0][0];
    expect(issue.title).toBe("CI failure on forge/fix-build");
    expect(issue.metadata.ci_fix).toBe(true);
    expect(issue.metadata.branch).toBe("forge/fix-build");
    expect(issue.metadata.sha).toBe("abc12345deadbeef");
    expect(issue.description).toContain("CI check suite failed");
    expect(issue.description).toContain("CI Error Log");
    expect(issue.labels).toContain("ci-fix");
  });

  it("includes CI error log in description", async () => {
    const handler = mockApp.handlers["check_suite.completed"];
    const octokit = { auth: { token: "test-token" } };
    await handler({ payload: checkSuitePayload(), octokit });

    const issue = (deps.onDispatch as any).mock.calls[0][0];
    expect(issue.description).toContain("error[E0308]: mismatched types");
  });

  it("skips non-failure conclusions", async () => {
    const handler = mockApp.handlers["check_suite.completed"];
    const octokit = { auth: { token: "test-token" } };
    await handler({
      payload: checkSuitePayload({ conclusion: "success" }),
      octokit,
    });

    expect(deps.onDispatch).not.toHaveBeenCalled();
  });

  it("skips non-forge branches", async () => {
    const handler = mockApp.handlers["check_suite.completed"];
    const octokit = { auth: { token: "test-token" } };
    await handler({
      payload: checkSuitePayload({ headBranch: "main" }),
      octokit,
    });

    expect(deps.onDispatch).not.toHaveBeenCalled();
  });

  it("skips when head_branch is null", async () => {
    const handler = mockApp.handlers["check_suite.completed"];
    const octokit = { auth: { token: "test-token" } };
    const payload = checkSuitePayload();
    payload.check_suite.head_branch = null as any;
    await handler({ payload, octokit });

    expect(deps.onDispatch).not.toHaveBeenCalled();
  });

  it("dispatches with correct repo context", async () => {
    const handler = mockApp.handlers["check_suite.completed"];
    const octokit = { auth: { token: "test-token" } };
    await handler({ payload: checkSuitePayload(), octokit });

    const repo = (deps.onDispatch as any).mock.calls[0][2];
    expect(repo).toEqual({ owner: "owner", repo: "repo" });
  });
});

describe("fetchCIErrorLog shared utility", () => {
  it("exports fetchCIErrorLog function", async () => {
    const mod = await import("../../src/github/ci-logs.js");
    expect(typeof mod.fetchCIErrorLog).toBe("function");
  });
});
