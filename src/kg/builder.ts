import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseModule } from "./parser.js";
import { buildDependencyGraph } from "./graph.js";
import { buildTestMappings } from "./test-mapping.js";
import { analyzeChangeCoupling } from "./git-history.js";
import {
  createKGDatabase,
  saveModules,
  saveEdges,
  saveTestMappings,
  saveChangeCoupling,
  saveMeta,
  getStats,
  deleteEdgesFrom,
  deleteTestMappingsFor,
} from "./storage.js";
import type { KnowledgeGraphStats, ModuleInfo } from "./types.js";

/**
 * Glob for TypeScript files in a repo, excluding common non-source directories.
 */
async function globTypeScriptFiles(repoPath: string): Promise<string[]> {
  await import("node:fs/promises").then(async () => {
    // Node 22+ has fs.glob, but for Node 20 compatibility, use a manual walk
    return { glob: null };
  });

  // Use a simple recursive walk for Node 20 compatibility
  const results: string[] = [];
  const { readdirSync } = await import("node:fs");

  const EXCLUDE_DIRS = new Set([
    'node_modules', 'dist', '.git', 'coverage', '.next', 'build', '.turbo',
  ]);

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDE_DIRS.has(entry.name)) {
          walk(join(dir, entry.name));
        }
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        // Skip declaration files
        if (!entry.name.endsWith('.d.ts')) {
          results.push(join(dir, entry.name));
        }
      }
    }
  }

  walk(repoPath);
  return results;
}

/**
 * Build the full knowledge graph from scratch.
 */
export async function buildFullGraph(
  repoPath: string,
  dbPath?: string,
): Promise<KnowledgeGraphStats> {
  const db = createKGDatabase(dbPath);

  try {
    // 1. Find all TypeScript files
    const files = await globTypeScriptFiles(repoPath);

    // 2. Parse each file
    const modules: ModuleInfo[] = [];
    for (const filePath of files) {
      try {
        const content = readFileSync(filePath, "utf-8");
        const stat = statSync(filePath);
        const mod = parseModule(filePath, content, repoPath);
        mod.lastModified = stat.mtime.toISOString();
        modules.push(mod);
      } catch {
        // Skip files that can't be read/parsed
      }
    }

    // 3. Build dependency graph
    const edges = buildDependencyGraph(modules);

    // 4. Build test mappings
    const testMappings = buildTestMappings(modules);

    // 5. Analyze change coupling from git history
    let couplings: Awaited<ReturnType<typeof analyzeChangeCoupling>>;
    try {
      couplings = await analyzeChangeCoupling(repoPath, {
        maxCommits: 500,
        minCochanges: 3,
        minScore: 0.3,
      });
    } catch {
      // Git analysis may fail (not a git repo, etc.)
      couplings = [];
    }

    // 6. Save everything to SQLite
    saveModules(db, modules);
    saveEdges(db, edges);
    saveTestMappings(db, testMappings);
    saveChangeCoupling(db, couplings);

    const now = new Date().toISOString();
    saveMeta(db, "last_full_build", now);

    return getStats(db);
  } finally {
    db.close();
  }
}

/**
 * Incremental graph update for changed files only.
 */
export async function buildIncrementalGraph(
  repoPath: string,
  changedFiles: string[],
  dbPath?: string,
): Promise<KnowledgeGraphStats> {
  const db = createKGDatabase(dbPath);

  try {
    // 1. Re-parse only changed files
    const modules: ModuleInfo[] = [];
    const changedRelPaths: string[] = [];

    for (const filePath of changedFiles) {
      const absPath = join(repoPath, filePath);
      try {
        const content = readFileSync(absPath, "utf-8");
        const stat = statSync(absPath);
        const mod = parseModule(absPath, content, repoPath);
        mod.lastModified = stat.mtime.toISOString();
        modules.push(mod);
        changedRelPaths.push(mod.path);
      } catch {
        // File may have been deleted — remove from db
        changedRelPaths.push(relative(repoPath, absPath).replace(/\\/g, '/'));
      }
    }

    // 2. Update modules in DB
    if (modules.length > 0) {
      saveModules(db, modules);
    }

    // 3. Re-build edges for changed files
    deleteEdgesFrom(db, changedRelPaths);
    if (modules.length > 0) {
      // Load all modules from DB to build edges correctly
      const allModules = loadAllModulesFromDb(db);
      const edges = buildDependencyGraph(allModules);
      // Only save edges from changed files
      const changedEdges = edges.filter(e => changedRelPaths.includes(e.from));
      if (changedEdges.length > 0) {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO kg_edges (from_path, to_path, imports_json, is_type_only)
          VALUES (?, ?, ?, ?)
        `);
        const tx = db.transaction(() => {
          for (const edge of changedEdges) {
            stmt.run(edge.from, edge.to, JSON.stringify(edge.imports), edge.isTypeOnly ? 1 : 0);
          }
        });
        tx();
      }
    }

    // 4. Re-build test mappings for changed files
    const sourceChanged = changedRelPaths.filter(p => !p.includes('.test.') && !p.includes('.spec.'));
    if (sourceChanged.length > 0) {
      deleteTestMappingsFor(db, sourceChanged);
      const allModules = loadAllModulesFromDb(db);
      const mappings = buildTestMappings(allModules);
      const relevantMappings = mappings.filter(m => sourceChanged.includes(m.sourceFile));
      if (relevantMappings.length > 0) {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO kg_test_mappings (source_file, test_file, confidence)
          VALUES (?, ?, ?)
        `);
        const tx = db.transaction(() => {
          for (const m of relevantMappings) {
            for (const tf of m.testFiles) {
              stmt.run(m.sourceFile, tf, m.confidence);
            }
          }
        });
        tx();
      }
    }

    // 5. Skip git history re-analysis (expensive, only on full build)

    const now = new Date().toISOString();
    saveMeta(db, "last_incremental", now);

    return getStats(db);
  } finally {
    db.close();
  }
}

function loadAllModulesFromDb(db: ReturnType<typeof createKGDatabase>): ModuleInfo[] {
  const rows = db.prepare("SELECT * FROM kg_modules").all() as Array<{
    path: string;
    exports_json: string;
    imports_json: string;
    is_test: number;
    last_modified: string | null;
  }>;

  return rows.map(r => ({
    path: r.path,
    exports: JSON.parse(r.exports_json),
    imports: JSON.parse(r.imports_json),
    isTest: r.is_test === 1,
    lastModified: r.last_modified || undefined,
  }));
}
