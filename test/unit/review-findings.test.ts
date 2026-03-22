import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, type AppDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrator.js";
import {
  createReviewFindingsRepository,
  type ReviewFindingsRepository,
} from "../../src/storage/repositories/review-findings.js";
import {
  accumulateFindings,
  extractModule,
  recordReviewCalibration,
} from "../../src/validation/review-agent.js";
import type { ReviewOutput } from "../../src/validation/review-agent.js";
import type { Logger } from "../../src/logging/logger.js";

function makeLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  } as unknown as Logger;
}

describe("ReviewFindingsRepository", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let repo: ReviewFindingsRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-findings-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    repo = createReviewFindingsRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upsertFinding creates a new finding", () => {
    repo.upsertFinding({
      category: "error_handling",
      pattern: "error_handling",
      module: "src/storage",
      exampleComment: "Missing try/catch around DB call",
    });

    const all = repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0].category).toBe("error_handling");
    expect(all[0].occurrenceCount).toBe(1);
    expect(all[0].promotedToConvention).toBe(false);
  });

  it("upsertFinding increments occurrence count on duplicate", () => {
    repo.upsertFinding({ category: "error_handling", pattern: "error_handling", module: "src/storage" });
    repo.upsertFinding({ category: "error_handling", pattern: "error_handling", module: "src/storage" });
    repo.upsertFinding({ category: "error_handling", pattern: "error_handling", module: "src/storage" });

    const all = repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0].occurrenceCount).toBe(3);
  });

  it("promoteEligible promotes findings at threshold", () => {
    repo.upsertFinding({ category: "error_handling", pattern: "error_handling", module: "src/storage" });
    repo.upsertFinding({ category: "error_handling", pattern: "error_handling", module: "src/storage" });
    repo.upsertFinding({ category: "error_handling", pattern: "error_handling", module: "src/storage" });

    const promoted = repo.promoteEligible();
    expect(promoted).toBe(1);

    const findings = repo.getPromotedFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0].promotedToConvention).toBe(true);
  });

  it("promoteEligible does not promote below threshold", () => {
    repo.upsertFinding({ category: "naming", pattern: "naming", module: "src/utils" });
    repo.upsertFinding({ category: "naming", pattern: "naming", module: "src/utils" });

    const promoted = repo.promoteEligible();
    expect(promoted).toBe(0);
  });

  it("promoteEligible respects custom threshold", () => {
    repo.upsertFinding({ category: "naming", pattern: "naming", module: "src/utils" });
    repo.upsertFinding({ category: "naming", pattern: "naming", module: "src/utils" });

    const promoted = repo.promoteEligible(2);
    expect(promoted).toBe(1);
  });

  it("getPromotedFindingsForModules filters by module", () => {
    repo.upsertFinding({ category: "error_handling", pattern: "error_handling", module: "src/storage" });
    repo.upsertFinding({ category: "error_handling", pattern: "error_handling", module: "src/storage" });
    repo.upsertFinding({ category: "error_handling", pattern: "error_handling", module: "src/storage" });
    repo.upsertFinding({ category: "naming", pattern: "naming", module: "src/agent" });
    repo.upsertFinding({ category: "naming", pattern: "naming", module: "src/agent" });
    repo.upsertFinding({ category: "naming", pattern: "naming", module: "src/agent" });

    repo.promoteEligible();

    const storageFindings = repo.getPromotedFindingsForModules(["src/storage"]);
    expect(storageFindings).toHaveLength(1);
    expect(storageFindings[0].module).toBe("src/storage");

    const agentFindings = repo.getPromotedFindingsForModules(["src/agent"]);
    expect(agentFindings).toHaveLength(1);
    expect(agentFindings[0].module).toBe("src/agent");
  });

  it("findings accumulate across runs", () => {
    // Simulate multiple review rounds
    repo.upsertFinding({ category: "error_handling", pattern: "error_handling", module: "src/storage", exampleComment: "First review" });
    repo.upsertFinding({ category: "error_handling", pattern: "error_handling", module: "src/storage", exampleComment: "Second review" });

    const all = repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0].occurrenceCount).toBe(2);
    expect(all[0].exampleComment).toBe("Second review");
  });
});

describe("reviewCalibration", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let repo: ReviewFindingsRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-calibration-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    repo = createReviewFindingsRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("recordCalibration creates a new calibration entry", () => {
    repo.recordCalibration("src/storage", 10, 2);
    const cal = repo.getCalibration("src/storage");
    expect(cal).toBeDefined();
    expect(cal!.totalComments).toBe(10);
    expect(cal!.overriddenComments).toBe(2);
    expect(cal!.falsePositiveRate).toBeCloseTo(0.2);
  });

  it("recordCalibration accumulates over time", () => {
    repo.recordCalibration("src/storage", 10, 2);
    repo.recordCalibration("src/storage", 10, 5);
    const cal = repo.getCalibration("src/storage");
    expect(cal!.totalComments).toBe(20);
    expect(cal!.overriddenComments).toBe(7);
    expect(cal!.falsePositiveRate).toBeCloseTo(0.35);
  });

  it("getMiscalibratedModules flags modules above threshold", () => {
    repo.recordCalibration("src/storage", 10, 5);
    repo.recordCalibration("src/agent", 10, 1);

    const miscalibrated = repo.getMiscalibratedModules();
    expect(miscalibrated).toHaveLength(1);
    expect(miscalibrated[0].module).toBe("src/storage");
  });

  it("getAllCalibration returns all calibration rows", () => {
    repo.recordCalibration("src/storage", 10, 4);
    repo.recordCalibration("src/agent", 10, 1);

    const all = repo.getAllCalibration();
    expect(all).toHaveLength(2);
    expect(all.map(c => c.module).sort()).toEqual(["src/agent", "src/storage"]);
  });

  it("false positive rate tracked per module", () => {
    repo.recordCalibration("src/storage", 10, 4);
    repo.recordCalibration("src/agent", 10, 1);

    const storageCal = repo.getCalibration("src/storage");
    const agentCal = repo.getCalibration("src/agent");

    expect(storageCal!.falsePositiveRate).toBeCloseTo(0.4);
    expect(agentCal!.falsePositiveRate).toBeCloseTo(0.1);
  });
});

describe("extractModule", () => {
  it("extracts top two directory segments", () => {
    expect(extractModule("src/storage/repositories/runs.ts")).toBe("src/storage");
  });

  it("handles single-segment paths", () => {
    expect(extractModule("file.ts")).toBe("file.ts");
  });

  it("handles two-segment paths", () => {
    expect(extractModule("src/index.ts")).toBe("src/index.ts");
  });
});

describe("accumulateFindings", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let repo: ReviewFindingsRepository;
  const logger = makeLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-accumulate-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    repo = createReviewFindingsRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accumulates findings from review output", () => {
    const output: ReviewOutput = {
      comments: [
        { file: "src/storage/database.ts", line: 10, severity: "MUST_FIX", category: "error_handling", comment: "Missing try/catch" },
        { file: "src/agent/invoke.ts", line: 5, severity: "SHOULD_FIX", category: "naming", comment: "Poor variable name" },
      ],
      summary: { must_fix: 1, should_fix: 1, nit: 0, overall: "Needs fixes" },
    };

    accumulateFindings(output, repo, logger);

    const all = repo.findAll();
    expect(all).toHaveLength(2);
  });

  it("promotes findings after 3 occurrences across reviews", () => {
    const makeOutput = (): ReviewOutput => ({
      comments: [
        { file: "src/storage/database.ts", line: 10, severity: "MUST_FIX", category: "error_handling", comment: "Missing typed error" },
      ],
      summary: { must_fix: 1, should_fix: 0, nit: 0, overall: "Fix" },
    });

    accumulateFindings(makeOutput(), repo, logger);
    accumulateFindings(makeOutput(), repo, logger);
    const promoted = accumulateFindings(makeOutput(), repo, logger);

    expect(promoted).toBe(1);
    const conventions = repo.getPromotedFindings();
    expect(conventions).toHaveLength(1);
    expect(conventions[0].occurrenceCount).toBe(3);
  });

  it("promoted findings appear in getPromotedFindingsForModules", () => {
    const output: ReviewOutput = {
      comments: [
        { file: "src/storage/database.ts", line: 10, severity: "MUST_FIX", category: "error_handling", comment: "Always use typed errors" },
      ],
      summary: { must_fix: 1, should_fix: 0, nit: 0, overall: "Fix" },
    };

    accumulateFindings(output, repo, logger);
    accumulateFindings(output, repo, logger);
    accumulateFindings(output, repo, logger);

    const findings = repo.getPromotedFindingsForModules(["src/storage"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].exampleComment).toBe("Always use typed errors");
  });
});

describe("recordReviewCalibration", () => {
  let db: AppDatabase;
  let tmpDir: string;
  let repo: ReviewFindingsRepository;
  const logger = makeLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgectl-calibration-fn-test-"));
    db = createDatabase(join(tmpDir, "test.db"));
    runMigrations(db);
    repo = createReviewFindingsRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records calibration and warns on miscalibration", () => {
    const warnings: string[] = [];
    const warnLogger = {
      ...logger,
      warn: (_tag: string, msg: string) => warnings.push(msg),
    } as unknown as Logger;

    recordReviewCalibration(repo, "src/storage", 10, 5, warnLogger);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Miscalibration");
    expect(warnings[0]).toContain("50.0%");
  });
});
