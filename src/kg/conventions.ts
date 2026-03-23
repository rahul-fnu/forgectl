import type { KGDatabase } from "./storage.js";

export interface Convention {
  id: number;
  category: string;
  pattern: string;
  module: string;
  description: string;
  confidence: number;
  source: string;
  ignored: boolean;
  createdAt: string;
  updatedAt: string;
}

const CONVENTIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS kg_conventions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  pattern TEXT NOT NULL,
  module TEXT NOT NULL,
  description TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL DEFAULT 'review',
  ignored INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(category, pattern, module)
)`;

function ensureTable(db: KGDatabase): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='kg_conventions'"
  ).get();
  if (!exists) {
    db.exec(CONVENTIONS_TABLE_SQL);
  }
}

function deserialize(row: Record<string, unknown>): Convention {
  return {
    id: row.id as number,
    category: row.category as string,
    pattern: row.pattern as string,
    module: row.module as string,
    description: row.description as string,
    confidence: row.confidence as number,
    source: row.source as string,
    ignored: (row.ignored as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function listConventions(db: KGDatabase): Convention[] {
  ensureTable(db);
  const rows = db.prepare("SELECT * FROM kg_conventions ORDER BY confidence DESC").all();
  return (rows as Record<string, unknown>[]).map(deserialize);
}

export function getConventionsForModule(db: KGDatabase, module: string): Convention[] {
  ensureTable(db);
  const rows = db.prepare(
    "SELECT * FROM kg_conventions WHERE module = ? OR module = '*' ORDER BY confidence DESC"
  ).all(module);
  return (rows as Record<string, unknown>[]).map(deserialize);
}

export function getActiveConventions(db: KGDatabase): Convention[] {
  ensureTable(db);
  const rows = db.prepare(
    "SELECT * FROM kg_conventions WHERE ignored = 0 ORDER BY confidence DESC"
  ).all();
  return (rows as Record<string, unknown>[]).map(deserialize);
}

export function getActiveConventionsForModules(db: KGDatabase, modules: string[]): Convention[] {
  ensureTable(db);
  if (modules.length === 0) return getActiveConventions(db);
  const placeholders = modules.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT * FROM kg_conventions WHERE ignored = 0 AND (module IN (${placeholders}) OR module = '*') ORDER BY confidence DESC`
  ).all(...modules);
  return (rows as Record<string, unknown>[]).map(deserialize);
}

export function ignoreConvention(db: KGDatabase, pattern: string): number {
  ensureTable(db);
  const now = new Date().toISOString();
  const result = db.prepare(
    "UPDATE kg_conventions SET ignored = 1, updated_at = ? WHERE pattern LIKE ? OR category LIKE ? OR description LIKE ?"
  ).run(now, `%${pattern}%`, `%${pattern}%`, `%${pattern}%`);
  return result.changes;
}

export function unignoreConvention(db: KGDatabase, pattern: string): number {
  ensureTable(db);
  const now = new Date().toISOString();
  const result = db.prepare(
    "UPDATE kg_conventions SET ignored = 0, updated_at = ? WHERE pattern LIKE ? OR category LIKE ? OR description LIKE ?"
  ).run(now, `%${pattern}%`, `%${pattern}%`, `%${pattern}%`);
  return result.changes;
}

export function upsertConvention(
  db: KGDatabase,
  params: {
    category: string;
    pattern: string;
    module: string;
    description: string;
    confidence: number;
    source: string;
  },
): void {
  ensureTable(db);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO kg_conventions (category, pattern, module, description, confidence, source, ignored, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(category, pattern, module) DO UPDATE SET
      description = excluded.description,
      confidence = excluded.confidence,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(params.category, params.pattern, params.module, params.description, params.confidence, params.source, now, now);
}

export function refreshConventionsFromFindings(
  db: KGDatabase,
  findings: Array<{
    category: string;
    pattern: string;
    module: string;
    occurrenceCount: number;
    exampleComment: string | null;
  }>,
): number {
  ensureTable(db);
  let count = 0;
  for (const f of findings) {
    if (f.occurrenceCount < 3) continue;
    const confidence = Math.min(1, f.occurrenceCount / 10);
    const description = f.exampleComment ?? `${f.category} in ${f.module}`;
    upsertConvention(db, {
      category: f.category,
      pattern: f.pattern,
      module: f.module,
      description,
      confidence,
      source: "review",
    });
    count++;
  }
  return count;
}
