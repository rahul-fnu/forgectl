import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import { createRunRepository, type RunRepository } from "../../src/storage/repositories/runs.js";
import { createEventRepository, type EventRepository } from "../../src/storage/repositories/events.js";
import { createCostRepository, type CostRepository } from "../../src/storage/repositories/costs.js";
import { filterKeyEvents, buildPromptText } from "../../src/analysis/run-summary.js";
import type { EventRow } from "../../src/storage/repositories/events.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFileSync: vi.fn().mockReturnValue(JSON.stringify({
      approach: "Test approach",
      keyActions: "Test actions",
      obstacles: "No obstacles",
      retries: "0 retries",
      outcome: "Success",
      tokenEfficiency: "Efficient",
    })),
  };
});

describe("run-summary", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let runRepo: RunRepository;
  let eventRepo: EventRepository;
  let costRepo: CostRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-run-summary-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    runRepo = createRunRepository(db);
    eventRepo = createEventRepository(db);
    costRepo = createCostRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("filterKeyEvents", () => {
    it("filters to only key event types", () => {
      const events: EventRow[] = [
        { id: 1, runId: "r1", type: "started", timestamp: "2026-01-01T00:00:00Z", data: null },
        { id: 2, runId: "r1", type: "phase", timestamp: "2026-01-01T00:01:00Z", data: null },
        { id: 3, runId: "r1", type: "validation_step", timestamp: "2026-01-01T00:02:00Z", data: { step: "lint" } },
        { id: 4, runId: "r1", type: "prompt", timestamp: "2026-01-01T00:03:00Z", data: null },
        { id: 5, runId: "r1", type: "retry", timestamp: "2026-01-01T00:04:00Z", data: null },
        { id: 6, runId: "r1", type: "loop_detected", timestamp: "2026-01-01T00:05:00Z", data: null },
        { id: 7, runId: "r1", type: "escalation", timestamp: "2026-01-01T00:06:00Z", data: null },
        { id: 8, runId: "r1", type: "completed", timestamp: "2026-01-01T00:07:00Z", data: null },
        { id: 9, runId: "r1", type: "agent_response", timestamp: "2026-01-01T00:08:00Z", data: null },
        { id: 10, runId: "r1", type: "failed", timestamp: "2026-01-01T00:09:00Z", data: null },
      ];

      const filtered = filterKeyEvents(events);
      expect(filtered).toHaveLength(7);
      const types = filtered.map((e) => e.type);
      expect(types).toEqual(["started", "validation_step", "retry", "loop_detected", "escalation", "completed", "failed"]);
    });

    it("returns empty array for no matching events", () => {
      const events: EventRow[] = [
        { id: 1, runId: "r1", type: "phase", timestamp: "2026-01-01T00:00:00Z", data: null },
        { id: 2, runId: "r1", type: "prompt", timestamp: "2026-01-01T00:01:00Z", data: null },
      ];
      expect(filterKeyEvents(events)).toHaveLength(0);
    });
  });

  describe("buildPromptText", () => {
    it("includes event log and cost data", () => {
      const events: EventRow[] = [
        { id: 1, runId: "r1", type: "started", timestamp: "2026-01-01T00:00:00Z", data: null },
        { id: 2, runId: "r1", type: "completed", timestamp: "2026-01-01T00:05:00Z", data: { status: "success" } },
      ];
      const cost = { totalInputTokens: 5000, totalOutputTokens: 2000, totalCostUsd: 0.045, recordCount: 1 };

      const prompt = buildPromptText(events, cost);
      expect(prompt).toContain("[2026-01-01T00:00:00Z] started");
      expect(prompt).toContain("[2026-01-01T00:05:00Z] completed");
      expect(prompt).toContain('"status":"success"');
      expect(prompt).toContain("Input tokens: 5000");
      expect(prompt).toContain("Output tokens: 2000");
      expect(prompt).toContain("$0.0450");
      expect(prompt).toContain('"approach"');
      expect(prompt).toContain('"tokenEfficiency"');
    });
  });

  describe("setSummary / getSummary", () => {
    it("stores and retrieves a run summary", () => {
      runRepo.insert({ id: "run-1", task: "test task", submittedAt: "2026-01-01T00:00:00Z" });

      const summary = {
        approach: "Used incremental approach",
        keyActions: "Modified src/index.ts",
        obstacles: "Lint errors on first attempt",
        retries: "2 validation cycles",
        outcome: "Success after fixing lint",
        tokenEfficiency: "5000 input, 2000 output, $0.045",
      };

      runRepo.setSummary("run-1", summary);
      const retrieved = runRepo.getSummary("run-1");
      expect(retrieved).toEqual(summary);
    });

    it("returns null for run without summary", () => {
      runRepo.insert({ id: "run-2", task: "test task", submittedAt: "2026-01-01T00:00:00Z" });
      expect(runRepo.getSummary("run-2")).toBeNull();
    });

    it("returns null for non-existent run", () => {
      expect(runRepo.getSummary("non-existent")).toBeNull();
    });
  });

  describe("generateRunSummary", () => {
    it("calls LLM and returns parsed summary", async () => {
      const { generateRunSummary } = await import("../../src/analysis/run-summary.js");

      runRepo.insert({ id: "run-llm", task: "llm test", submittedAt: "2026-01-01T00:00:00Z" });
      eventRepo.insert({ runId: "run-llm", type: "started", timestamp: "2026-01-01T00:00:00Z" });
      eventRepo.insert({ runId: "run-llm", type: "completed", timestamp: "2026-01-01T00:05:00Z" });
      costRepo.insert({ runId: "run-llm", agentType: "claude-code", inputTokens: 5000, outputTokens: 2000, costUsd: 0.045, timestamp: "2026-01-01T00:05:00Z" });

      const result = await generateRunSummary("run-llm", eventRepo, costRepo);
      expect(result).toEqual({
        approach: "Test approach",
        keyActions: "Test actions",
        obstacles: "No obstacles",
        retries: "0 retries",
        outcome: "Success",
        tokenEfficiency: "Efficient",
      });
    });
  });
});
