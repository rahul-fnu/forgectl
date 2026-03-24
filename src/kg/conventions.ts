import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KGDatabase } from "./storage.js";
import type { ModuleInfo, ExportEntry, ImportEntry } from "./types.js";

export interface Convention {
  id?: number;
  pattern: string;
  module: string;
  description?: string;
  category?: string;
  confidence: number;
  source?: "mined" | "review" | "merged";
  occurrences?: number;
  lastSeen?: string;
  examples?: string[];
  ignored?: boolean;
}

interface ModuleRow {
  path: string;
  exports_json: string;
  imports_json: string;
  is_test: number;
}

function loadAllModules(db: KGDatabase): ModuleInfo[] {
  const rows = db.prepare("SELECT path, exports_json, imports_json, is_test FROM kg_modules").all() as ModuleRow[];
  return rows.map(r => ({
    path: r.path,
    exports: JSON.parse(r.exports_json) as ExportEntry[],
    imports: JSON.parse(r.imports_json) as ImportEntry[],
    isTest: r.is_test === 1,
  }));
}

function groupByDirectory(modules: ModuleInfo[]): Map<string, ModuleInfo[]> {
  const groups = new Map<string, ModuleInfo[]>();
  for (const mod of modules) {
    const dir = dirname(mod.path);
    const list = groups.get(dir) ?? [];
    list.push(mod);
    groups.set(dir, list);
  }
  return groups;
}

function analyzeExportPatterns(modules: ModuleInfo[]): Convention[] {
  const conventions: Convention[] = [];
  const groups = groupByDirectory(modules);

  for (const [dir, mods] of groups) {
    const sourceMods = mods.filter(m => !m.isTest);
    if (sourceMods.length < 2) continue;

    // Detect barrel exports (index.ts re-exports)
    const indexMod = sourceMods.find(m => m.path.endsWith("/index.ts") || m.path === "index.ts");
    if (indexMod && indexMod.imports.length > 0) {
      const localImports = indexMod.imports.filter(i => i.source.startsWith(dir + "/") || i.source.startsWith("./"));
      if (localImports.length >= 2) {
        conventions.push({
          pattern: "barrel exports via index.ts re-exports",
          module: dir,
          confidence: Math.min(1.0, localImports.length / sourceMods.length),
          examples: localImports.slice(0, 3).map(i => `re-exports from ${i.source}`),
        });
      }
    }

    // Detect factory function pattern (createXxx)
    const factoryMods: string[] = [];
    for (const mod of sourceMods) {
      const factories = mod.exports.filter(
        e => e.kind === "function" && /^create[A-Z]/.test(e.name),
      );
      if (factories.length > 0) {
        factoryMods.push(`${mod.path}: ${factories.map(f => f.name).join(", ")}`);
      }
    }
    if (factoryMods.length >= 2) {
      conventions.push({
        pattern: "factory function pattern (createXxx)",
        module: dir,
        confidence: factoryMods.length / sourceMods.length,
        examples: factoryMods.slice(0, 3),
      });
    }

    // Detect class-based exports
    const classMods: string[] = [];
    for (const mod of sourceMods) {
      const classes = mod.exports.filter(e => e.kind === "class");
      if (classes.length > 0) {
        classMods.push(`${mod.path}: ${classes.map(c => c.name).join(", ")}`);
      }
    }
    if (classMods.length >= 2) {
      const classRatio = classMods.length / sourceMods.length;
      conventions.push({
        pattern: "class-based exports",
        module: dir,
        confidence: classRatio,
        examples: classMods.slice(0, 3),
      });
    }

    // Detect interface-heavy modules (types files)
    const interfaceMods: string[] = [];
    for (const mod of sourceMods) {
      const typeExports = mod.exports.filter(e => e.kind === "interface" || e.kind === "type");
      if (typeExports.length >= 3) {
        interfaceMods.push(`${mod.path}: ${typeExports.length} type exports`);
      }
    }
    if (interfaceMods.length >= 1) {
      conventions.push({
        pattern: "dedicated type definition files",
        module: dir,
        confidence: 0.9,
        examples: interfaceMods.slice(0, 3),
      });
    }
  }

  return conventions;
}

function analyzeImportPatterns(modules: ModuleInfo[]): Convention[] {
  const conventions: Convention[] = [];
  const groups = groupByDirectory(modules);

  for (const [dir, mods] of groups) {
    const sourceMods = mods.filter(m => !m.isTest);
    if (sourceMods.length < 2) continue;

    // Detect type-only import separation
    let typeOnlySeparated = 0;
    const typeOnlyExamples: string[] = [];
    for (const mod of sourceMods) {
      const hasTypeOnly = mod.imports.some(i => i.isTypeOnly);
      const hasValue = mod.imports.some(i => !i.isTypeOnly);
      if (hasTypeOnly && hasValue) {
        typeOnlySeparated++;
        if (typeOnlyExamples.length < 3) {
          typeOnlyExamples.push(`${mod.path}: separates type-only imports`);
        }
      }
    }
    if (typeOnlySeparated >= 2) {
      conventions.push({
        pattern: "type-only imports separated from value imports",
        module: dir,
        confidence: typeOnlySeparated / sourceMods.length,
        examples: typeOnlyExamples,
      });
    }

    // Detect absolute (src/) vs relative (./) import preference
    let absoluteCount = 0;
    let relativeCount = 0;
    for (const mod of sourceMods) {
      for (const imp of mod.imports) {
        if (imp.source.startsWith("src/")) absoluteCount++;
        else if (imp.source.startsWith("./") || imp.source.startsWith("../")) relativeCount++;
      }
    }
    const total = absoluteCount + relativeCount;
    if (total >= 5) {
      if (absoluteCount > relativeCount * 2) {
        conventions.push({
          pattern: "absolute imports (src/ paths)",
          module: dir,
          confidence: absoluteCount / total,
          examples: [`${absoluteCount} absolute vs ${relativeCount} relative imports`],
        });
      } else if (relativeCount > absoluteCount * 2) {
        conventions.push({
          pattern: "relative imports (./ paths)",
          module: dir,
          confidence: relativeCount / total,
          examples: [`${relativeCount} relative vs ${absoluteCount} absolute imports`],
        });
      }
    }
  }

  return conventions;
}

function analyzeTestingPatterns(modules: ModuleInfo[]): Convention[] {
  const conventions: Convention[] = [];
  const testModules = modules.filter(m => m.isTest);

  if (testModules.length === 0) return conventions;

  const groups = groupByDirectory(testModules);

  for (const [dir, mods] of groups) {
    if (mods.length < 2) continue;

    // Test file naming: .test.ts vs .spec.ts
    const testNamed = mods.filter(m => m.path.includes(".test."));
    const specNamed = mods.filter(m => m.path.includes(".spec."));
    if (testNamed.length > specNamed.length && testNamed.length >= 2) {
      conventions.push({
        pattern: "test file naming: *.test.ts",
        module: dir,
        confidence: testNamed.length / mods.length,
        examples: testNamed.slice(0, 3).map(m => m.path),
      });
    } else if (specNamed.length > testNamed.length && specNamed.length >= 2) {
      conventions.push({
        pattern: "test file naming: *.spec.ts",
        module: dir,
        confidence: specNamed.length / mods.length,
        examples: specNamed.slice(0, 3).map(m => m.path),
      });
    }

    // Test structure: check imports for describe/it/vi patterns
    const vitestUsers: string[] = [];
    const viMockUsers: string[] = [];
    for (const mod of mods) {
      const vitestImport = mod.imports.find(
        i => i.source === "vitest" || i.source.endsWith("/vitest"),
      );
      if (vitestImport) {
        const hasDescribe = vitestImport.names.includes("describe");
        const hasIt = vitestImport.names.includes("it");
        const hasVi = vitestImport.names.includes("vi");
        if (hasDescribe && hasIt) {
          vitestUsers.push(mod.path);
        }
        if (hasVi) {
          viMockUsers.push(mod.path);
        }
      }
    }
    if (vitestUsers.length >= 2) {
      conventions.push({
        pattern: "test structure: describe/it blocks (vitest)",
        module: dir,
        confidence: vitestUsers.length / mods.length,
        examples: vitestUsers.slice(0, 3),
      });
    }
    if (viMockUsers.length >= 2) {
      conventions.push({
        pattern: "mocking with vi.fn()/vi.mock() (vitest)",
        module: dir,
        confidence: viMockUsers.length / mods.length,
        examples: viMockUsers.slice(0, 3),
      });
    }

    // Setup patterns: beforeEach
    const beforeEachUsers: string[] = [];
    for (const mod of mods) {
      const vitestImport = mod.imports.find(i => i.source === "vitest");
      if (vitestImport?.names.includes("beforeEach")) {
        beforeEachUsers.push(mod.path);
      }
    }
    if (beforeEachUsers.length >= 2) {
      conventions.push({
        pattern: "test setup using beforeEach",
        module: dir,
        confidence: beforeEachUsers.length / mods.length,
        examples: beforeEachUsers.slice(0, 3),
      });
    }
  }

  return conventions;
}

function analyzeErrorHandlingPatterns(
  modules: ModuleInfo[],
  repoRoot: string,
): Convention[] {
  const conventions: Convention[] = [];
  const sourceModules = modules.filter(m => !m.isTest);
  const groups = groupByDirectory(sourceModules);

  for (const [dir, mods] of groups) {
    if (mods.length < 2) continue;

    let tryCatchCount = 0;
    let throwCount = 0;
    const tryCatchExamples: string[] = [];
    const throwExamples: string[] = [];
    const customErrorExamples: string[] = [];

    for (const mod of mods) {
      let content: string;
      try {
        content = readFileSync(join(repoRoot, mod.path), "utf-8");
      } catch {
        continue;
      }

      const tryCatches = content.match(/\btry\s*\{/g);
      if (tryCatches && tryCatches.length > 0) {
        tryCatchCount++;
        if (tryCatchExamples.length < 3) {
          tryCatchExamples.push(`${mod.path}: ${tryCatches.length} try/catch blocks`);
        }
      }

      const throws = content.match(/\bthrow\s+new\s+(\w+)/g);
      if (throws && throws.length > 0) {
        throwCount++;
        if (throwExamples.length < 3) {
          throwExamples.push(`${mod.path}: ${throws.join(", ")}`);
        }
        // Detect custom error classes
        const customErrors = throws
          .map(t => t.replace(/^throw\s+new\s+/, ""))
          .filter(e => e !== "Error" && e !== "TypeError" && e !== "RangeError");
        if (customErrors.length > 0 && customErrorExamples.length < 3) {
          customErrorExamples.push(`${mod.path}: ${customErrors.join(", ")}`);
        }
      }
    }

    if (tryCatchCount >= 2) {
      conventions.push({
        pattern: "error handling with try/catch",
        module: dir,
        confidence: tryCatchCount / mods.length,
        examples: tryCatchExamples,
      });
    }
    if (throwCount >= 2) {
      conventions.push({
        pattern: "error propagation via throw",
        module: dir,
        confidence: throwCount / mods.length,
        examples: throwExamples,
      });
    }
    if (customErrorExamples.length >= 1) {
      conventions.push({
        pattern: "custom error classes",
        module: dir,
        confidence: customErrorExamples.length / mods.length,
        examples: customErrorExamples,
      });
    }
  }

  return conventions;
}

export function analyzeConventions(
  db: KGDatabase,
  repoRoot: string,
): Convention[] {
  const modules = loadAllModules(db);
  if (modules.length === 0) return [];

  const conventions: Convention[] = [
    ...analyzeExportPatterns(modules),
    ...analyzeImportPatterns(modules),
    ...analyzeTestingPatterns(modules),
    ...analyzeErrorHandlingPatterns(modules, repoRoot),
  ];

  // Sort by confidence descending
  conventions.sort((a, b) => b.confidence - a.confidence);

  return conventions;
}

export function saveConventions(db: KGDatabase, conventions: Convention[]): void {
  // Store conventions in kg_meta as JSON
  db.prepare(
    "INSERT OR REPLACE INTO kg_meta (key, value) VALUES (?, ?)",
  ).run("conventions", JSON.stringify(conventions));
  db.prepare(
    "INSERT OR REPLACE INTO kg_meta (key, value) VALUES (?, ?)",
  ).run("conventions_updated_at", new Date().toISOString());
}

export function loadConventions(db: KGDatabase): Convention[] {
  const row = db.prepare(
    "SELECT value FROM kg_meta WHERE key = 'conventions'",
  ).get() as { value: string } | undefined;
  if (!row) return [];
  return JSON.parse(row.value) as Convention[];
}

/**
 * Extract unique module prefixes (directory paths) from file paths.
 * e.g., ["src/auth/store.ts", "src/auth/claude.ts"] → ["src/auth"]
 */
export function extractModulePrefixes(paths: string[]): string[] {
  const prefixes = new Set<string>();
  for (const p of paths) {
    let dir = dirname(p);
    while (dir && dir !== ".") {
      prefixes.add(dir);
      dir = dirname(dir);
    }
  }
  return [...prefixes];
}

/**
 * Get conventions relevant to the given module prefixes.
 * Filters by minimum confidence threshold.
 */
export function getConventionsForModules(
  db: KGDatabase,
  modulePrefixes: string[],
  minConfidence: number,
): Convention[] {
  const all = loadStoredConventions(db);
  return all.filter(c =>
    c.confidence >= minConfidence &&
    !c.ignored &&
    (c.module === "*" || modulePrefixes.some(prefix =>
      c.module === prefix ||
      c.module.startsWith(prefix + "/") ||
      prefix.startsWith(c.module + "/")
    ))
  );
}

/**
 * Format conventions as a text block suitable for agent context injection.
 */
export function formatConventionsForContext(conventions: Convention[]): string {
  if (!conventions || conventions.length === 0) return "";

  const grouped = new Map<string, Convention[]>();
  for (const c of conventions) {
    const key = c.module;
    const list = grouped.get(key) ?? [];
    list.push(c);
    grouped.set(key, list);
  }

  const sections: string[] = [];
  for (const [mod, convs] of grouped) {
    const label = mod === "*"
      ? "Global:"
      : `When working in ${mod}/:`;
    const lines = convs.map(c => {
      const desc = c.description ?? c.pattern;
      return `- ${desc} (confidence: ${(c.confidence * 100).toFixed(0)}%)`;
    });
    sections.push(`${label}\n${lines.join("\n")}`);
  }

  return `## Conventions\n\n${sections.join("\n\n")}`;
}

/**
 * Save a single convention to the KG database (stored conventions table in kg_meta).
 * Upserts: if module+pattern already exists, bumps occurrences and updates confidence/description.
 */
export function saveConvention(db: KGDatabase, conv: Omit<Convention, "id" | "examples">): void {
  const all = loadStoredConventions(db);
  const existing = all.find(c => c.module === conv.module && c.pattern === conv.pattern);
  if (existing) {
    existing.confidence = conv.confidence;
    existing.occurrences = (existing.occurrences ?? 0) + (conv.occurrences ?? 1);
    existing.lastSeen = conv.lastSeen;
    if (conv.description) existing.description = conv.description;
    if (conv.source) existing.source = conv.source;
  } else {
    all.push({
      id: all.length > 0 ? Math.max(...all.map(c => c.id ?? 0)) + 1 : 1,
      ...conv,
      occurrences: conv.occurrences ?? 1,
    });
  }
  db.prepare("INSERT OR REPLACE INTO kg_meta (key, value) VALUES (?, ?)").run(
    "stored_conventions", JSON.stringify(all),
  );
}

/**
 * Get all stored conventions (individual convention records with id/source/description).
 */
function getAllConventions(db: KGDatabase): Convention[] {
  return loadStoredConventions(db);
}

function loadStoredConventions(db: KGDatabase): Convention[] {
  const row = db.prepare(
    "SELECT value FROM kg_meta WHERE key = 'stored_conventions'",
  ).get() as { value: string } | undefined;
  if (!row) return [];
  return JSON.parse(row.value) as Convention[];
}

/**
 * Merge promoted review findings into conventions.
 * Only processes findings where promotedToConvention is true.
 * Returns count of conventions created or updated.
 */
function mergeReviewFindingsWithConventions(
  db: KGDatabase,
  findings: Array<{
    category: string;
    pattern: string;
    module: string;
    occurrenceCount: number;
    firstSeen: string;
    lastSeen: string;
    promotedToConvention: boolean;
    exampleComment: string | null;
  }>,
): number {
  let count = 0;
  for (const f of findings) {
    if (!f.promotedToConvention) continue;

    const all = loadStoredConventions(db);
    const existing = all.find(c => c.module === f.module && c.pattern === f.pattern);
    if (existing) {
      existing.confidence = Math.min(1.0, existing.confidence + 0.1);
      existing.occurrences = (existing.occurrences ?? 0) + f.occurrenceCount;
      existing.lastSeen = f.lastSeen;
      existing.source = "merged";
      db.prepare("INSERT OR REPLACE INTO kg_meta (key, value) VALUES (?, ?)").run(
        "stored_conventions", JSON.stringify(all),
      );
    } else {
      saveConvention(db, {
        module: f.module,
        pattern: f.pattern,
        description: f.exampleComment ?? undefined,
        confidence: 0.7,
        source: "review",
        occurrences: f.occurrenceCount,
        lastSeen: f.lastSeen,
      });
    }
    count++;
  }
  return count;
}

/**
 * Record whether a convention was followed or not in a given run.
 */
export function recordConventionCompliance(
  db: KGDatabase,
  conventionId: number,
  followed: boolean,
  runId: string,
): void {
  db.exec(`CREATE TABLE IF NOT EXISTS kg_convention_compliance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    convention_id INTEGER NOT NULL,
    followed INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.prepare(
    "INSERT INTO kg_convention_compliance (convention_id, followed, run_id) VALUES (?, ?, ?)",
  ).run(conventionId, followed ? 1 : 0, runId);
}

/**
 * List all stored conventions (alias for getAllConventions).
 */
export function listConventions(db: KGDatabase): Convention[] {
  return getAllConventions(db);
}

/**
 * Get conventions for a single module prefix.
 */
export function getConventionsForModule(db: KGDatabase, module: string): Convention[] {
  const all = loadStoredConventions(db);
  return all.filter(c =>
    !c.ignored &&
    (c.module === module || c.module.startsWith(module + "/") || module.startsWith(c.module + "/")),
  );
}

/**
 * Mark conventions matching a pattern as ignored.
 * Returns count of conventions ignored.
 */
export function ignoreConvention(db: KGDatabase, pattern: string): number {
  const all = loadStoredConventions(db);
  let count = 0;
  for (const c of all) {
    if (c.pattern.includes(pattern) || c.module.includes(pattern)) {
      c.ignored = true;
      count++;
    }
  }
  if (count > 0) {
    db.prepare("INSERT OR REPLACE INTO kg_meta (key, value) VALUES (?, ?)").run(
      "stored_conventions", JSON.stringify(all),
    );
  }
  return count;
}

/**
 * Refresh conventions from review findings.
 * Returns count of conventions synced.
 */
export function refreshConventionsFromFindings(
  db: KGDatabase,
  findings: Array<{
    category: string;
    pattern: string;
    module: string;
    occurrenceCount: number;
    firstSeen: string;
    lastSeen: string;
    promotedToConvention: boolean;
    exampleComment: string | null;
  }>,
): number {
  return mergeReviewFindingsWithConventions(db, findings);
}
