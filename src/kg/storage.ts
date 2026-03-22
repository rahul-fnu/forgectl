import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ModuleInfo,
  DependencyEdge,
  TestCoverageMapping,
  ChangeCoupling,
  KnowledgeGraphStats,
} from "./types.js";

export type KGDatabase = Database.Database;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kg_modules (
  path TEXT PRIMARY KEY NOT NULL,
  exports_json TEXT NOT NULL,
  imports_json TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0,
  last_modified TEXT,
  content_hash TEXT,
  tree_hash TEXT,
  compressed_content TEXT,
  token_count INTEGER,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kg_edges (
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  imports_json TEXT NOT NULL,
  is_type_only INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_path, to_path)
);

CREATE TABLE IF NOT EXISTS kg_test_mappings (
  source_file TEXT NOT NULL,
  test_file TEXT NOT NULL,
  confidence TEXT NOT NULL,
  PRIMARY KEY (source_file, test_file)
);

CREATE TABLE IF NOT EXISTS kg_change_coupling (
  file_a TEXT NOT NULL,
  file_b TEXT NOT NULL,
  cochange_count INTEGER NOT NULL,
  total_commits INTEGER NOT NULL,
  coupling_score REAL NOT NULL,
  PRIMARY KEY (file_a, file_b)
);

CREATE TABLE IF NOT EXISTS kg_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`;

/**
 * Create or open a KG SQLite database.
 * Uses its own db file separate from the main forgectl.db.
 */
export function createKGDatabase(dbPath?: string): KGDatabase {
  const resolvedPath =
    dbPath ?? join(process.env.HOME || "/tmp", ".forgectl", "kg.db");

  mkdirSync(dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  // Initialize schema
  db.exec(SCHEMA_SQL);

  // Migrate existing databases: add new columns if missing
  const columns = db.prepare("PRAGMA table_info(kg_modules)").all() as Array<{ name: string }>;
  const colNames = new Set(columns.map(c => c.name));
  if (!colNames.has("content_hash")) {
    db.exec("ALTER TABLE kg_modules ADD COLUMN content_hash TEXT");
  }
  if (!colNames.has("tree_hash")) {
    db.exec("ALTER TABLE kg_modules ADD COLUMN tree_hash TEXT");
  }
  if (!colNames.has("compressed_content")) {
    db.exec("ALTER TABLE kg_modules ADD COLUMN compressed_content TEXT");
  }
  if (!colNames.has("token_count")) {
    db.exec("ALTER TABLE kg_modules ADD COLUMN token_count INTEGER");
  }

  return db;
}

/**
 * Save modules (upsert).
 */
export function saveModules(db: KGDatabase, modules: ModuleInfo[]): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO kg_modules (path, exports_json, imports_json, is_test, last_modified, content_hash, tree_hash, compressed_content, token_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const tx = db.transaction(() => {
    for (const mod of modules) {
      stmt.run(
        mod.path,
        JSON.stringify(mod.exports),
        JSON.stringify(mod.imports),
        mod.isTest ? 1 : 0,
        mod.lastModified || null,
        mod.contentHash || null,
        mod.treeHash || null,
        mod.compressedContent || null,
        mod.tokenCount || null,
      );
    }
  });

  tx();
}

/**
 * Save dependency edges (replace all).
 */
export function saveEdges(db: KGDatabase, edges: DependencyEdge[]): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM kg_edges").run();

    const stmt = db.prepare(`
      INSERT INTO kg_edges (from_path, to_path, imports_json, is_type_only)
      VALUES (?, ?, ?, ?)
    `);

    for (const edge of edges) {
      stmt.run(
        edge.from,
        edge.to,
        JSON.stringify(edge.imports),
        edge.isTypeOnly ? 1 : 0,
      );
    }
  });

  tx();
}

/**
 * Save test mappings (replace all).
 */
export function saveTestMappings(db: KGDatabase, mappings: TestCoverageMapping[]): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM kg_test_mappings").run();

    const stmt = db.prepare(`
      INSERT INTO kg_test_mappings (source_file, test_file, confidence)
      VALUES (?, ?, ?)
    `);

    for (const mapping of mappings) {
      for (const testFile of mapping.testFiles) {
        stmt.run(mapping.sourceFile, testFile, mapping.confidence);
      }
    }
  });

  tx();
}

/**
 * Save change coupling data (replace all).
 */
export function saveChangeCoupling(db: KGDatabase, couplings: ChangeCoupling[]): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM kg_change_coupling").run();

    const stmt = db.prepare(`
      INSERT INTO kg_change_coupling (file_a, file_b, cochange_count, total_commits, coupling_score)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const c of couplings) {
      stmt.run(c.fileA, c.fileB, c.cochangeCount, c.totalCommits, c.couplingScore);
    }
  });

  tx();
}

/**
 * Get a single module by path.
 */
export function getModule(db: KGDatabase, path: string): ModuleInfo | undefined {
  const row = db.prepare("SELECT * FROM kg_modules WHERE path = ?").get(path) as {
    path: string;
    exports_json: string;
    imports_json: string;
    is_test: number;
    last_modified: string | null;
    content_hash: string | null;
    tree_hash: string | null;
    compressed_content: string | null;
    token_count: number | null;
  } | undefined;

  if (!row) return undefined;

  return {
    path: row.path,
    exports: JSON.parse(row.exports_json),
    imports: JSON.parse(row.imports_json),
    isTest: row.is_test === 1,
    lastModified: row.last_modified || undefined,
    contentHash: row.content_hash || undefined,
    treeHash: row.tree_hash || undefined,
    compressedContent: row.compressed_content || undefined,
    tokenCount: row.token_count || undefined,
  };
}

/**
 * Get dependency edges where the target is the given path (who imports it).
 */
export function getDependents(db: KGDatabase, path: string): DependencyEdge[] {
  const rows = db.prepare("SELECT * FROM kg_edges WHERE to_path = ?").all(path) as Array<{
    from_path: string;
    to_path: string;
    imports_json: string;
    is_type_only: number;
  }>;

  return rows.map(r => ({
    from: r.from_path,
    to: r.to_path,
    imports: JSON.parse(r.imports_json),
    isTypeOnly: r.is_type_only === 1,
  }));
}

/**
 * Get test mappings for a source file.
 */
export function getTestsFor(db: KGDatabase, sourcePath: string): TestCoverageMapping[] {
  const rows = db.prepare("SELECT * FROM kg_test_mappings WHERE source_file = ?").all(sourcePath) as Array<{
    source_file: string;
    test_file: string;
    confidence: string;
  }>;

  if (rows.length === 0) return [];

  // Group by source_file
  const testFiles = rows.map(r => r.test_file);
  const confidence = rows[0].confidence as TestCoverageMapping['confidence'];

  return [{
    sourceFile: sourcePath,
    testFiles,
    confidence,
  }];
}

/**
 * Get change-coupled files for a given path.
 */
export function getCoupledFiles(db: KGDatabase, path: string): ChangeCoupling[] {
  const rows = db.prepare(
    "SELECT * FROM kg_change_coupling WHERE file_a = ? OR file_b = ? ORDER BY coupling_score DESC"
  ).all(path, path) as Array<{
    file_a: string;
    file_b: string;
    cochange_count: number;
    total_commits: number;
    coupling_score: number;
  }>;

  return rows.map(r => ({
    fileA: r.file_a,
    fileB: r.file_b,
    cochangeCount: r.cochange_count,
    totalCommits: r.total_commits,
    couplingScore: r.coupling_score,
  }));
}

/**
 * Get overall knowledge graph statistics.
 */
export function getStats(db: KGDatabase): KnowledgeGraphStats {
  const moduleCount = (db.prepare("SELECT COUNT(*) as count FROM kg_modules").get() as { count: number }).count;
  const edgeCount = (db.prepare("SELECT COUNT(*) as count FROM kg_edges").get() as { count: number }).count;
  const testMappingCount = (db.prepare("SELECT COUNT(DISTINCT source_file) as count FROM kg_test_mappings").get() as { count: number }).count;
  const couplingCount = (db.prepare("SELECT COUNT(*) as count FROM kg_change_coupling").get() as { count: number }).count;

  const lastFullBuild = getMeta(db, "last_full_build");
  const lastIncremental = getMeta(db, "last_incremental");
  const rootHash = getMeta(db, "root_hash");
  const lastRootHash = getMeta(db, "last_root_hash");

  let changedSinceLastBuild: number | undefined;
  if (rootHash && lastRootHash) {
    changedSinceLastBuild = rootHash === lastRootHash ? 0 :
      (db.prepare("SELECT COUNT(*) as count FROM kg_modules WHERE content_hash IS NOT NULL AND content_hash != COALESCE((SELECT value FROM kg_meta WHERE key = 'prev_content_hash_' || kg_modules.path), '')").get() as { count: number }).count;
  }

  return {
    totalModules: moduleCount,
    totalEdges: edgeCount,
    totalTestMappings: testMappingCount,
    totalCouplingPairs: couplingCount,
    lastFullBuild: lastFullBuild || undefined,
    lastIncremental: lastIncremental || undefined,
    rootHash: rootHash || undefined,
    changedSinceLastBuild,
  };
}

/**
 * Save a metadata key-value pair.
 */
export function saveMeta(db: KGDatabase, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO kg_meta (key, value) VALUES (?, ?)").run(key, value);
}

/**
 * Get a metadata value by key.
 */
export function getMeta(db: KGDatabase, key: string): string | null {
  const row = db.prepare("SELECT value FROM kg_meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Delete edges originating from specific files (for incremental rebuild).
 */
export function deleteEdgesFrom(db: KGDatabase, paths: string[]): void {
  const stmt = db.prepare("DELETE FROM kg_edges WHERE from_path = ?");
  const tx = db.transaction(() => {
    for (const p of paths) {
      stmt.run(p);
    }
  });
  tx();
}

/**
 * Delete test mappings for specific source files (for incremental rebuild).
 */
export function deleteTestMappingsFor(db: KGDatabase, sourceFiles: string[]): void {
  const stmt = db.prepare("DELETE FROM kg_test_mappings WHERE source_file = ?");
  const tx = db.transaction(() => {
    for (const f of sourceFiles) {
      stmt.run(f);
    }
  });
  tx();
}
