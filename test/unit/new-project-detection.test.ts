import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrackerIssue, TrackerAdapter } from "../../src/tracker/types.js";
import type { ForgectlConfig } from "../../src/config/schema.js";
import type { Logger } from "../../src/logging/logger.js";
import {
  detectNewProject,
  extractOrgFromConfig,
  handleNewProjectIssue,
  type NewProjectDetection,
} from "../../src/project/create.js";

function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    id: "1",
    identifier: "#1",
    title: "Test issue",
    description: "desc",
    state: "open",
    priority: null,
    labels: [],
    assignees: [],
    url: "https://example.com/1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    blocked_by: [],
    metadata: {},
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function makeTracker(): TrackerAdapter {
  return {
    kind: "linear",
    fetchCandidateIssues: vi.fn().mockResolvedValue([]),
    fetchIssueStatesByIds: vi.fn().mockResolvedValue(new Map()),
    fetchIssuesByStates: vi.fn().mockResolvedValue([]),
    postComment: vi.fn().mockResolvedValue(undefined),
    updateState: vi.fn().mockResolvedValue(undefined),
    updateLabels: vi.fn().mockResolvedValue(undefined),
    createIssue: vi.fn().mockResolvedValue("CHILD-1"),
  } as unknown as TrackerAdapter;
}

function makeConfig(overrides: Partial<ForgectlConfig> = {}): ForgectlConfig {
  return {
    orchestrator: {
      enabled: true,
      max_concurrent_agents: 3,
      poll_interval_ms: 30000,
      stall_timeout_ms: 600000,
      max_retries: 5,
      max_retry_backoff_ms: 300000,
      drain_timeout_ms: 30000,
      continuation_delay_ms: 1000,
      in_progress_label: "in-progress",
    },
    tracker: {
      kind: "linear",
      token: "test-token",
      active_states: ["open"],
      terminal_states: ["closed"],
      poll_interval_ms: 30000,
      auto_close: false,
      comments_enabled: true,
      comment_events: ["completed"],
      repo: "myorg/myrepo",
    },
    project: {
      auto_create: false,
    },
    ...overrides,
  } as unknown as ForgectlConfig;
}

describe("detectNewProject", () => {
  it("detects 'new project' in title", () => {
    const issue = makeIssue({ title: "Create a new project for auth service" });
    const result = detectNewProject(issue);
    expect(result.isNewProject).toBe(true);
  });

  it("detects 'create repo' in title", () => {
    const issue = makeIssue({ title: "Create repo for user-service" });
    const result = detectNewProject(issue);
    expect(result.isNewProject).toBe(true);
  });

  it("detects 'scaffold' in description", () => {
    const issue = makeIssue({ description: "Scaffold a new Python microservice" });
    const result = detectNewProject(issue);
    expect(result.isNewProject).toBe(true);
  });

  it("detects **Stack:** in description", () => {
    const issue = makeIssue({
      description: "Build a new API\n**Stack:** Python + FastAPI",
    });
    const result = detectNewProject(issue);
    expect(result.isNewProject).toBe(true);
    expect(result.stack).toBe("python");
  });

  it("detects new-project label", () => {
    const issue = makeIssue({ labels: ["new-project"] });
    const result = detectNewProject(issue);
    expect(result.isNewProject).toBe(true);
  });

  it("returns false for normal issues", () => {
    const issue = makeIssue({ title: "Fix login bug", description: "The login page crashes" });
    const result = detectNewProject(issue);
    expect(result.isNewProject).toBe(false);
  });

  it("extracts project name from **Repo:** field", () => {
    const issue = makeIssue({
      title: "New project",
      description: "**Repo:** https://github.com/myorg/my-service",
    });
    const result = detectNewProject(issue);
    expect(result.isNewProject).toBe(true);
    expect(result.projectName).toBe("my-service");
  });

  it("extracts project name from title", () => {
    const issue = makeIssue({ title: "Create repo my-api" });
    const result = detectNewProject(issue);
    expect(result.isNewProject).toBe(true);
    expect(result.projectName).toBe("my-api");
  });

  it("extracts stack from **Stack:** field", () => {
    const issue = makeIssue({
      title: "New project",
      description: "**Stack:** Go + gRPC",
    });
    const result = detectNewProject(issue);
    expect(result.stack).toBe("go");
  });

  it("extracts stack from keywords in description", () => {
    const issue = makeIssue({
      title: "New project",
      description: "We need a FastAPI backend",
    });
    const result = detectNewProject(issue);
    expect(result.stack).toBe("python");
  });

  it("extracts features from description", () => {
    const issue = makeIssue({
      title: "New project",
      description: [
        "Create a new service",
        "## Features",
        "- User authentication",
        "- REST API endpoints",
        "- Database migrations",
      ].join("\n"),
    });
    const result = detectNewProject(issue);
    expect(result.features).toEqual([
      "User authentication",
      "REST API endpoints",
      "Database migrations",
    ]);
  });

  it("extracts features from Requirements section", () => {
    const issue = makeIssue({
      title: "New project",
      description: [
        "Build a service",
        "## Requirements",
        "- OAuth2 login",
        "- Admin dashboard",
      ].join("\n"),
    });
    const result = detectNewProject(issue);
    expect(result.features).toEqual(["OAuth2 login", "Admin dashboard"]);
  });
});

describe("extractOrgFromConfig", () => {
  it("returns github_org from project config", () => {
    const config = makeConfig({
      project: { auto_create: true, github_org: "custom-org" },
    } as any);
    expect(extractOrgFromConfig(config)).toBe("custom-org");
  });

  it("falls back to tracker repo org", () => {
    const config = makeConfig();
    expect(extractOrgFromConfig(config)).toBe("myorg");
  });

  it("returns null when no org available", () => {
    const config = makeConfig({ tracker: undefined } as any);
    (config as any).project = { auto_create: true };
    expect(extractOrgFromConfig(config)).toBeNull();
  });
});

describe("handleNewProjectIssue", () => {
  let tracker: TrackerAdapter;
  let logger: Logger;

  beforeEach(() => {
    tracker = makeTracker();
    logger = makeLogger();
  });

  it("returns false when auto_create is disabled", async () => {
    const config = makeConfig();
    const detection: NewProjectDetection = {
      isNewProject: true,
      projectName: "my-service",
      stack: "python",
      features: [],
    };
    const result = await handleNewProjectIssue(makeIssue(), detection, tracker, config, logger);
    expect(result).toBe(false);
  });

  it("returns false and posts comment when no project name", async () => {
    const config = makeConfig({ project: { auto_create: true } } as any);
    const detection: NewProjectDetection = {
      isNewProject: true,
      projectName: null,
      stack: null,
      features: [],
    };
    const result = await handleNewProjectIssue(makeIssue(), detection, tracker, config, logger);
    expect(result).toBe(false);
    expect(tracker.postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("could not determine project name"),
    );
  });

  it("returns false when no org configured", async () => {
    const config = makeConfig({
      project: { auto_create: true },
      tracker: undefined,
    } as any);
    const detection: NewProjectDetection = {
      isNewProject: true,
      projectName: "my-service",
      stack: "python",
      features: [],
    };
    const result = await handleNewProjectIssue(makeIssue(), detection, tracker, config, logger);
    expect(result).toBe(false);
  });
});

describe("dispatcher new-project integration", () => {
  it("detectNewProject is called with issue in dispatchIssue flow", () => {
    const issue = makeIssue({
      title: "Create repo my-new-app",
      description: "**Stack:** Python\n**Repo:** https://github.com/org/my-new-app",
    });
    const detection = detectNewProject(issue);
    expect(detection.isNewProject).toBe(true);
    expect(detection.projectName).toBe("my-new-app");
    expect(detection.stack).toBe("python");
  });

  it("normal issues are not detected as new-project", () => {
    const issue = makeIssue({
      title: "Fix the login page",
      description: "Login page throws 500 on submit",
    });
    const detection = detectNewProject(issue);
    expect(detection.isNewProject).toBe(false);
  });
});
