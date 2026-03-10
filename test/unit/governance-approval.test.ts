import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RunRepository, RunRow } from "../../src/storage/repositories/runs.js";
import {
  approveRun,
  rejectRun,
  requestRevision,
  enterPendingApproval,
  enterPendingOutputApproval,
} from "../../src/governance/approval.js";

function makeRunRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1",
    task: "test task",
    workflow: "test-workflow",
    status: "queued",
    options: null,
    submittedAt: "2026-01-01T00:00:00Z",
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
    pauseReason: null,
    pauseContext: null,
    approvalContext: null,
    approvalAction: null,
    ...overrides,
  };
}

function mockRunRepo(run?: RunRow): RunRepository {
  const store = run ? { ...run } : undefined;
  return {
    insert: vi.fn(),
    findById: vi.fn(() => store),
    updateStatus: vi.fn((id, params) => {
      if (store) {
        store.status = params.status;
        if (params.completedAt) store.completedAt = params.completedAt;
        if (params.error !== undefined) store.error = params.error;
        if (params.approvalContext !== undefined)
          store.approvalContext = params.approvalContext;
        if (params.approvalAction !== undefined)
          store.approvalAction = params.approvalAction;
      }
    }),
    findByStatus: vi.fn(() => []),
    list: vi.fn(() => []),
    clearPauseContext: vi.fn(),
  };
}

describe("approveRun", () => {
  it("transitions pending_approval to running", () => {
    const run = makeRunRow({ status: "pending_approval" });
    const repo = mockRunRepo(run);
    const result = approveRun(repo, "run-1");
    expect(result.previousStatus).toBe("pending_approval");
    expect(repo.updateStatus).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "running" }),
    );
  });

  it("transitions pending_output_approval to completed", () => {
    const run = makeRunRow({ status: "pending_output_approval" });
    const repo = mockRunRepo(run);
    const result = approveRun(repo, "run-1");
    expect(result.previousStatus).toBe("pending_output_approval");
    expect(repo.updateStatus).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("throws for non-pending status", () => {
    const run = makeRunRow({ status: "running" });
    const repo = mockRunRepo(run);
    expect(() => approveRun(repo, "run-1")).toThrow();
  });

  it("throws when run not found", () => {
    const repo = mockRunRepo();
    expect(() => approveRun(repo, "nonexistent")).toThrow();
  });
});

describe("rejectRun", () => {
  it("transitions pending_approval to rejected", () => {
    const run = makeRunRow({ status: "pending_approval" });
    const repo = mockRunRepo(run);
    rejectRun(repo, "run-1", "Not safe");
    expect(repo.updateStatus).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "rejected", error: "Not safe" }),
    );
  });

  it("transitions pending_output_approval to rejected", () => {
    const run = makeRunRow({ status: "pending_output_approval" });
    const repo = mockRunRepo(run);
    rejectRun(repo, "run-1", "Bad output");
    expect(repo.updateStatus).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "rejected", error: "Bad output" }),
    );
  });

  it("throws for non-pending status", () => {
    const run = makeRunRow({ status: "completed" });
    const repo = mockRunRepo(run);
    expect(() => rejectRun(repo, "run-1")).toThrow();
  });

  it("throws when run not found", () => {
    const repo = mockRunRepo();
    expect(() => rejectRun(repo, "nonexistent")).toThrow();
  });
});

describe("requestRevision", () => {
  it("stores ApprovalContext and transitions pending_approval to running", () => {
    const run = makeRunRow({ status: "pending_approval" });
    const repo = mockRunRepo(run);
    requestRevision(repo, "run-1", "Please fix the tests");
    expect(repo.updateStatus).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        status: "running",
        approvalContext: expect.objectContaining({
          action: "revision_requested",
          feedback: "Please fix the tests",
        }),
        approvalAction: "revision_requested",
      }),
    );
  });

  it("stores ApprovalContext and transitions pending_output_approval to running", () => {
    const run = makeRunRow({ status: "pending_output_approval" });
    const repo = mockRunRepo(run);
    requestRevision(repo, "run-1", "Needs more tests");
    expect(repo.updateStatus).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        status: "running",
        approvalContext: expect.objectContaining({
          action: "revision_requested",
          feedback: "Needs more tests",
        }),
      }),
    );
  });

  it("throws for non-pending status", () => {
    const run = makeRunRow({ status: "queued" });
    const repo = mockRunRepo(run);
    expect(() => requestRevision(repo, "run-1", "feedback")).toThrow();
  });

  it("throws when run not found", () => {
    const repo = mockRunRepo();
    expect(() => requestRevision(repo, "nonexistent", "feedback")).toThrow();
  });
});

describe("enterPendingApproval", () => {
  it("transitions queued to pending_approval", () => {
    const run = makeRunRow({ status: "queued" });
    const repo = mockRunRepo(run);
    enterPendingApproval(repo, "run-1");
    expect(repo.updateStatus).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "pending_approval" }),
    );
  });

  it("transitions running to pending_approval", () => {
    const run = makeRunRow({ status: "running" });
    const repo = mockRunRepo(run);
    enterPendingApproval(repo, "run-1");
    expect(repo.updateStatus).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "pending_approval" }),
    );
  });
});

describe("enterPendingOutputApproval", () => {
  it("transitions running to pending_output_approval", () => {
    const run = makeRunRow({ status: "running" });
    const repo = mockRunRepo(run);
    enterPendingOutputApproval(repo, "run-1");
    expect(repo.updateStatus).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "pending_output_approval" }),
    );
  });
});
