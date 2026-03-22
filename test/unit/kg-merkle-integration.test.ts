import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildFullGraph, buildIncrementalGraph } from "../../src/kg/builder.js";
import {
  createKGDatabase,
  getModule,
  getMeta,
} from "../../src/kg/storage.js";
import type { KGDatabase } from "../../src/kg/storage.js";
import { buildContext } from "../../src/context/builder.js";
import type { TaskSpec } from "../../src/task/types.js";

/**
 * End-to-end Merkle integration test:
 * build KG → change file → incremental update → verify hash propagation → context assembly → cache
 */

let tmpDir: string;
let dbPath: string;

function makeTask(files: string[]): TaskSpec {
  return {
    id: "merkle-integration-test",
    title: "Test merkle integration",
    context: { files, modules: [] },
    constraints: [],
    acceptance: [],
    decomposition: { strategy: "auto" },
    effort: { max_turns: 5 },
  };
}

/**
 * Create a temp directory with TypeScript files that import each other:
 *
 *   types.ts        (no deps, exports interface + type)
 *   utils.ts        (imports types.ts, exports functions)
 *   core.ts         (imports utils.ts, exports class)
 *   service.ts      (imports core.ts + utils.ts, exports class)
 *   handler.ts      (imports service.ts, exports function)
 *   config.ts       (no deps, exports const)
 *   logger.ts       (imports config.ts, exports class)
 *   unrelated.ts    (no deps, exports function)
 */
function createTestFiles(dir: string) {
  const srcDir = join(dir, "src");
  mkdirSync(srcDir, { recursive: true });

  writeFileSync(
    join(srcDir, "types.ts"),
    `export interface Config { name: string; }
export type Status = "ok" | "error";
`,
  );

  writeFileSync(
    join(srcDir, "utils.ts"),
    `import type { Status } from "./types.js";
export function formatStatus(s: Status): string { return s; }
export function slugify(text: string): string { return text.toLowerCase(); }
`,
  );

  writeFileSync(
    join(srcDir, "core.ts"),
    `import { slugify } from "./utils.js";
export class Core {
  run(name: string) { return slugify(name); }
}
`,
  );

  writeFileSync(
    join(srcDir, "service.ts"),
    `import { Core } from "./core.js";
import { formatStatus } from "./utils.js";
export class Service {
  private core = new Core();
  status() { return formatStatus("ok"); }
}
`,
  );

  writeFileSync(
    join(srcDir, "handler.ts"),
    `import { Service } from "./service.js";
export function handle() { return new Service(); }
`,
  );

  writeFileSync(
    join(srcDir, "config.ts"),
    `export const DEFAULT_PORT = 3000;
export const APP_NAME = "test-app";
`,
  );

  writeFileSync(
    join(srcDir, "logger.ts"),
    `import { APP_NAME } from "./config.js";
export class Logger {
  log(msg: string) { console.log(APP_NAME, msg); }
}
`,
  );

  writeFileSync(
    join(srcDir, "unrelated.ts"),
    `export function standalone() { return 42; }
`,
  );
}

describe("Merkle Integration — end-to-end change detection and context assembly", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kg-merkle-int-"));
    dbPath = join(tmpDir, "kg.db");
    createTestFiles(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("full build populates content_hash, tree_hash, token_count for all modules", async () => {
    const stats = await buildFullGraph(tmpDir, dbPath);

    expect(stats.totalModules).toBe(8);
    expect(stats.totalEdges).toBeGreaterThan(0);
    expect(stats.rootHash).toBeDefined();

    const db = createKGDatabase(dbPath);
    try {
      const files = [
        "src/types.ts", "src/utils.ts", "src/core.ts", "src/service.ts",
        "src/handler.ts", "src/config.ts", "src/logger.ts", "src/unrelated.ts",
      ];
      for (const f of files) {
        const mod = getModule(db, f);
        expect(mod, `module ${f} should exist`).toBeDefined();
        expect(mod!.contentHash, `${f} should have content_hash`).toBeTruthy();
        expect(mod!.treeHash, `${f} should have tree_hash`).toBeTruthy();
        expect(mod!.tokenCount, `${f} should have token_count`).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });

  it("root hash is deterministic (build twice, same result)", async () => {
    const stats1 = await buildFullGraph(tmpDir, dbPath);
    const dbPath2 = join(tmpDir, "kg2.db");
    const stats2 = await buildFullGraph(tmpDir, dbPath2);

    expect(stats1.rootHash).toBe(stats2.rootHash);
  });

  it("incremental update after file change propagates hashes correctly", async () => {
    // 1. Full build
    await buildFullGraph(tmpDir, dbPath);

    // Capture pre-change hashes
    let db = createKGDatabase(dbPath);
    const preUtils = getModule(db, "src/utils.ts")!;
    const preCore = getModule(db, "src/core.ts")!;
    const preService = getModule(db, "src/service.ts")!;
    const preHandler = getModule(db, "src/handler.ts")!;
    const preUnrelated = getModule(db, "src/unrelated.ts")!;
    const preConfig = getModule(db, "src/config.ts")!;
    const preRootHash = getMeta(db, "root_hash")!;
    db.close();

    // 2. Modify utils.ts — add an export
    writeFileSync(
      join(tmpDir, "src/utils.ts"),
      `import type { Status } from "./types.js";
export function formatStatus(s: Status): string { return s; }
export function slugify(text: string): string { return text.toLowerCase(); }
export function newHelper(): boolean { return true; }
`,
    );

    // 3. Incremental update
    await buildIncrementalGraph(tmpDir, ["src/utils.ts"], dbPath);

    // 4. Verify changes
    db = createKGDatabase(dbPath);
    try {
      const postUtils = getModule(db, "src/utils.ts")!;
      const postCore = getModule(db, "src/core.ts")!;
      const postService = getModule(db, "src/service.ts")!;
      const postHandler = getModule(db, "src/handler.ts")!;
      const postUnrelated = getModule(db, "src/unrelated.ts")!;
      const postConfig = getModule(db, "src/config.ts")!;
      const postRootHash = getMeta(db, "root_hash")!;

      // Changed file: new content_hash
      expect(postUtils.contentHash).not.toBe(preUtils.contentHash);

      // Dependents of utils.ts (core, service) should have new tree_hash
      expect(postCore.treeHash).not.toBe(preCore.treeHash);
      expect(postService.treeHash).not.toBe(preService.treeHash);

      // Transitive dependent (handler depends on service) should also update
      expect(postHandler.treeHash).not.toBe(preHandler.treeHash);

      // Unrelated files: unchanged content_hash and tree_hash
      expect(postUnrelated.contentHash).toBe(preUnrelated.contentHash);
      expect(postUnrelated.treeHash).toBe(preUnrelated.treeHash);

      // config.ts is not related to utils.ts — unchanged
      expect(postConfig.contentHash).toBe(preConfig.contentHash);
      expect(postConfig.treeHash).toBe(preConfig.treeHash);

      // Root hash changed
      expect(postRootHash).not.toBe(preRootHash);
    } finally {
      db.close();
    }
  });

  it("context builder includes dependents of changed module", async () => {
    await buildFullGraph(tmpDir, dbPath);

    const db = createKGDatabase(dbPath);
    try {
      const task = makeTask(["src/utils.ts"]);
      const result = await buildContext(task, db);

      const includedPaths = result.includedFiles.map(f => f.path);

      // utils.ts is directly referenced
      expect(includedPaths).toContain("src/utils.ts");

      // core.ts and service.ts import utils.ts — should be included as dependents
      expect(includedPaths).toContain("src/core.ts");
      expect(includedPaths).toContain("src/service.ts");

      // types.ts is a dependency of utils.ts — should be included
      expect(includedPaths).toContain("src/types.ts");
    } finally {
      db.close();
    }
  });

  it("context cache hit when Merkle root unchanged", async () => {
    await buildFullGraph(tmpDir, dbPath);

    const db = createKGDatabase(dbPath);
    try {
      const task = makeTask(["src/core.ts"]);

      // First call — populates cache
      const result1 = await buildContext(task, db);

      // Second call — should return identical result from cache
      const result2 = await buildContext(task, db);

      expect(result1).toEqual(result2);
      expect(result2.merkleRoot).toBe(result1.merkleRoot);
    } finally {
      db.close();
    }
  });

  it("context cache miss after incremental update changes root hash", async () => {
    await buildFullGraph(tmpDir, dbPath);

    // Build context before change
    let db = createKGDatabase(dbPath);
    const task = makeTask(["src/core.ts"]);
    const resultBefore = await buildContext(task, db);
    const rootBefore = resultBefore.merkleRoot;
    db.close();

    // Modify core.ts
    writeFileSync(
      join(tmpDir, "src/core.ts"),
      `import { slugify } from "./utils.js";
export class Core {
  run(name: string) { return slugify(name); }
}
export function createCore(): Core { return new Core(); }
`,
    );

    // Incremental update
    await buildIncrementalGraph(tmpDir, ["src/core.ts"], dbPath);

    // Build context after change — different merkle root → cache miss → different result
    db = createKGDatabase(dbPath);
    try {
      const resultAfter = await buildContext(task, db);

      expect(resultAfter.merkleRoot).not.toBe(rootBefore);
      // The context itself should have updated content
      expect(resultAfter.taskContext).toContain("createCore");
    } finally {
      db.close();
    }
  });

  it("directory-level tree hashes update when child changes", async () => {
    await buildFullGraph(tmpDir, dbPath);

    // Get pre-change directory tree hash
    let db = createKGDatabase(dbPath);
    const preDirHash = db
      .prepare("SELECT value FROM kg_meta WHERE key = 'root_hash'")
      .get() as { value: string } | undefined;
    db.close();

    // Modify a file
    writeFileSync(
      join(tmpDir, "src/config.ts"),
      `export const DEFAULT_PORT = 8080;
export const APP_NAME = "test-app";
export const VERSION = "2.0.0";
`,
    );

    await buildIncrementalGraph(tmpDir, ["src/config.ts"], dbPath);

    db = createKGDatabase(dbPath);
    try {
      const postDirHash = db
        .prepare("SELECT value FROM kg_meta WHERE key = 'root_hash'")
        .get() as { value: string } | undefined;

      // Root hash should change when any child changes
      expect(postDirHash?.value).not.toBe(preDirHash?.value);
    } finally {
      db.close();
    }
  });
});
