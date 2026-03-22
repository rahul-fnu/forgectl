import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildContext } from "../../src/context/builder.js";
import {
  createKGDatabase,
  saveModules,
  saveEdges,
  saveChangeCoupling,
  saveTestMappings,
  saveMeta,
} from "../../src/kg/storage.js";
import type { KGDatabase } from "../../src/kg/storage.js";
import type { ModuleInfo, DependencyEdge, ChangeCoupling, TestCoverageMapping } from "../../src/kg/types.js";
import type { TaskSpec } from "../../src/task/types.js";

function makeTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "test-task-001",
    title: "Fix the widget",
    description: "Fix widget rendering in src/widget.ts",
    context: { files: ["src/widget.ts"], modules: [] },
    constraints: ["Must not break existing tests"],
    acceptance: [{ run: "npm test", description: "Tests pass" }],
    decomposition: { strategy: "auto" },
    effort: { max_turns: 10 },
    ...overrides,
  };
}

function seedKG(db: KGDatabase) {
  const modules: ModuleInfo[] = [
    {
      path: "src/widget.ts",
      exports: [{ name: "Widget", kind: "class" }, { name: "createWidget", kind: "function" }],
      imports: [{ source: "src/utils.ts", names: ["helper"], isTypeOnly: false }],
      isTest: false,
      compressedContent: 'import { helper } from "src/utils.ts"\nexport class Widget\nexport function createWidget',
      tokenCount: 20,
      contentHash: "abc123",
    },
    {
      path: "src/utils.ts",
      exports: [{ name: "helper", kind: "function" }, { name: "format", kind: "function" }],
      imports: [],
      isTest: false,
      compressedContent: "export function helper\nexport function format",
      tokenCount: 10,
      contentHash: "def456",
    },
    {
      path: "src/app.ts",
      exports: [{ name: "App", kind: "class" }],
      imports: [{ source: "src/widget.ts", names: ["Widget"], isTypeOnly: false }],
      isTest: false,
      compressedContent: 'import { Widget } from "src/widget.ts"\nexport class App',
      tokenCount: 12,
      contentHash: "ghi789",
    },
    {
      path: "src/deep.ts",
      exports: [{ name: "Deep", kind: "class" }],
      imports: [{ source: "src/utils.ts", names: ["format"], isTypeOnly: false }],
      isTest: false,
      compressedContent: 'import { format } from "src/utils.ts"\nexport class Deep',
      tokenCount: 10,
      contentHash: "jkl012",
    },
    {
      path: "test/widget.test.ts",
      exports: [],
      imports: [{ source: "src/widget.ts", names: ["Widget"], isTypeOnly: false }],
      isTest: true,
      compressedContent: 'import { Widget } from "src/widget.ts"',
      tokenCount: 8,
      contentHash: "mno345",
    },
    {
      path: "src/unrelated.ts",
      exports: [{ name: "Unrelated", kind: "class" }],
      imports: [],
      isTest: false,
      compressedContent: "export class Unrelated",
      tokenCount: 5,
      contentHash: "pqr678",
    },
  ];

  const edges: DependencyEdge[] = [
    { from: "src/widget.ts", to: "src/utils.ts", imports: ["helper"], isTypeOnly: false },
    { from: "src/app.ts", to: "src/widget.ts", imports: ["Widget"], isTypeOnly: false },
    { from: "src/deep.ts", to: "src/utils.ts", imports: ["format"], isTypeOnly: false },
    { from: "test/widget.test.ts", to: "src/widget.ts", imports: ["Widget"], isTypeOnly: false },
  ];

  const couplings: ChangeCoupling[] = [
    { fileA: "src/widget.ts", fileB: "src/app.ts", cochangeCount: 5, totalCommits: 10, couplingScore: 0.8 },
  ];

  const testMappings: TestCoverageMapping[] = [
    { sourceFile: "src/widget.ts", testFiles: ["test/widget.test.ts"], confidence: "import" },
  ];

  saveModules(db, modules);
  saveEdges(db, edges);
  saveChangeCoupling(db, couplings);
  saveTestMappings(db, testMappings);
  saveMeta(db, "root_hash", "root_abc_123");
}

describe("Context Builder", () => {
  let db: KGDatabase;

  beforeEach(() => {
    db = createKGDatabase(":memory:");
    seedKG(db);
  });

  afterEach(() => {
    db.close();
  });

  it("assembles context with correct budget split", async () => {
    const task = makeTask();
    const result = await buildContext(task, db, 60000);

    expect(result.budget.max).toBe(60000);
    expect(result.budget.reservedForAgent).toBe(30000);
    expect(result.budget.used).toBeLessThanOrEqual(30000);
  });

  it("includes directly referenced files at full tier", async () => {
    const task = makeTask();
    const result = await buildContext(task, db);

    const widget = result.includedFiles.find(f => f.path === "src/widget.ts");
    expect(widget).toBeDefined();
    expect(widget!.tier).toBe("full");
  });

  it("includes imported files at full tier (score 0.7)", async () => {
    const task = makeTask();
    const result = await buildContext(task, db);

    const utils = result.includedFiles.find(f => f.path === "src/utils.ts");
    expect(utils).toBeDefined();
    expect(utils!.tier).toBe("full");
  });

  it("includes dependents at full tier (score 0.7)", async () => {
    const task = makeTask();
    const result = await buildContext(task, db);

    const app = result.includedFiles.find(f => f.path === "src/app.ts");
    expect(app).toBeDefined();
    expect(app!.tier).toBe("full");
  });

  it("includes test files for referenced sources", async () => {
    const task = makeTask();
    const result = await buildContext(task, db);

    const testFile = result.includedFiles.find(f => f.path === "test/widget.test.ts");
    expect(testFile).toBeDefined();
  });

  it("does not include unrelated files", async () => {
    const task = makeTask();
    const result = await buildContext(task, db);

    const unrelated = result.includedFiles.find(f => f.path === "src/unrelated.ts");
    expect(unrelated).toBeUndefined();
  });

  it("includes transitive dependencies at lower tier", async () => {
    const task = makeTask();
    const result = await buildContext(task, db);

    // deep.ts is 2-hop from widget: widget -> utils (dep) -> deep (dependent of utils)
    // Since we expand both forward deps and reverse dependents from 1-hop nodes,
    // deep.ts should be discovered at score 0.3
    const deep = result.includedFiles.find(f => f.path === "src/deep.ts");
    expect(deep).toBeDefined();
    expect(deep!.tier).toBe("name");
  });

  it("respects token budget", async () => {
    const task = makeTask();
    // Very small budget - should limit files
    const result = await buildContext(task, db, 100);

    expect(result.budget.used).toBeLessThanOrEqual(50); // half of 100
    expect(result.includedFiles.length).toBeLessThan(6);
  });

  it("produces sensible relevance ordering", async () => {
    const task = makeTask();
    const result = await buildContext(task, db);

    const paths = result.includedFiles.map(f => f.path);
    // Direct reference should come first
    expect(paths[0]).toBe("src/widget.ts");
  });

  it("includes merkle root in result", async () => {
    const task = makeTask();
    const result = await buildContext(task, db);

    expect(result.merkleRoot).toBe("root_abc_123");
  });

  it("returns cached result when codebase unchanged", async () => {
    const task = makeTask();
    const result1 = await buildContext(task, db);
    const result2 = await buildContext(task, db);

    expect(result1).toEqual(result2);
    expect(result2.merkleRoot).toBe("root_abc_123");
  });

  it("generates taskContext with file content", async () => {
    const task = makeTask();
    const result = await buildContext(task, db);

    expect(result.taskContext).toContain("src/widget.ts");
    expect(result.taskContext).toContain("relevance: 1.0");
  });

  it("generates systemContext header", async () => {
    const task = makeTask();
    const result = await buildContext(task, db);

    expect(result.systemContext).toContain("Knowledge Graph");
    expect(result.systemContext).toContain("root_abc_123");
  });

  it("extracts file references from task description", async () => {
    const task = makeTask({
      description: "Also check src/utils.ts and src/deep.ts for issues",
      context: { files: [], modules: [] },
    });
    const result = await buildContext(task, db);

    const utils = result.includedFiles.find(f => f.path === "src/utils.ts");
    const deep = result.includedFiles.find(f => f.path === "src/deep.ts");
    expect(utils).toBeDefined();
    expect(deep).toBeDefined();
  });

  it("handles empty KG gracefully", async () => {
    const emptyDb = createKGDatabase(":memory:");
    const task = makeTask();
    const result = await buildContext(task, emptyDb);

    expect(result.includedFiles).toHaveLength(0);
    expect(result.budget.used).toBe(0);
    emptyDb.close();
  });

  it("handles task with no context files", async () => {
    const task = makeTask({
      description: "A task with no file references",
      context: { files: [] },
    });
    const result = await buildContext(task, db);

    expect(result.includedFiles).toHaveLength(0);
  });
});
