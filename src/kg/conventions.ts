import type { KGDatabase } from "./storage.js";
import type { ReviewFindingRow } from "../storage/repositories/review-findings.js";

export interface Convention {
  id: number;
  module: string;
  pattern: string;
  description: string;
  confidence: number;
  source: "mined" | "review" | "merged";
  occurrences: number;
  lastSeen: string;
}

export interface ConventionCompliance {
  conventionId: number;
  followed: boolean;
  runId: string;
  timestamp: string;
}

const CONVENTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS kg_conventions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module TEXT NOT NULL,
  pattern TEXT NOT NULL,
  description TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL DEFAULT 'mined',
  occurrences INTEGER NOT NULL DEFAULT 1,
  last_seen TEXT NOT NULL,
  UNIQUE(module, pattern)
);

CREATE TABLE IF NOT EXISTS kg_convention_compliance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  convention_id INTEGER NOT NULL,
  followed INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
`;

export function ensureConventionTables(db: KGDatabase): void {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='kg_conventions'",
    )
    .all();
  if (tables.length === 0) {
    db.exec(CONVENTIONS_SCHEMA);
  }
}

export function saveConvention(
  db: KGDatabase,
  conv: Omit<Convention, "id">,
): void {
  ensureConventionTables(db);
  const now = conv.lastSeen || new Date().toISOString();
  db.prepare(
    `INSERT INTO kg_conventions (module, pattern, description, confidence, source, occurrences, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(module, pattern) DO UPDATE SET
       description = excluded.description,
       confidence = MAX(kg_conventions.confidence, excluded.confidence),
       source = CASE WHEN excluded.source = 'merged' THEN 'merged' ELSE kg_conventions.source END,
       occurrences = kg_conventions.occurrences + 1,
       last_seen = excluded.last_seen`,
  ).run(
    conv.module,
    conv.pattern,
    conv.description,
    conv.confidence,
    conv.source,
    conv.occurrences,
    now,
  );
}

export function getConventionsForModules(
  db: KGDatabase,
  modules: string[],
  minConfidence = 0.7,
): Convention[] {
  ensureConventionTables(db);
  if (modules.length === 0) return [];

  const placeholders = modules.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM kg_conventions
       WHERE (module IN (${placeholders}) OR module = '*')
         AND confidence >= ?
       ORDER BY confidence DESC, occurrences DESC`,
    )
    .all(...modules, minConfidence) as Array<{
    id: number;
    module: string;
    pattern: string;
    description: string;
    confidence: number;
    source: string;
    occurrences: number;
    last_seen: string;
  }>;

  return rows.map(deserializeConvention);
}

export function getAllConventions(
  db: KGDatabase,
  minConfidence = 0.0,
): Convention[] {
  ensureConventionTables(db);
  const rows = db
    .prepare(
      `SELECT * FROM kg_conventions WHERE confidence >= ? ORDER BY confidence DESC`,
    )
    .all(minConfidence) as Array<{
    id: number;
    module: string;
    pattern: string;
    description: string;
    confidence: number;
    source: string;
    occurrences: number;
    last_seen: string;
  }>;

  return rows.map(deserializeConvention);
}

export function mergeReviewFindingsWithConventions(
  db: KGDatabase,
  findings: ReviewFindingRow[],
): number {
  ensureConventionTables(db);
  let merged = 0;

  for (const finding of findings) {
    if (!finding.promotedToConvention) continue;

    const existing = db
      .prepare(
        `SELECT * FROM kg_conventions WHERE module = ? AND pattern = ?`,
      )
      .get(finding.module, finding.pattern) as
      | { id: number; confidence: number }
      | undefined;

    if (existing) {
      const boostedConfidence = Math.min(1.0, existing.confidence + 0.1);
      db.prepare(
        `UPDATE kg_conventions SET confidence = ?, source = 'merged', occurrences = occurrences + ? WHERE id = ?`,
      ).run(boostedConfidence, finding.occurrenceCount, existing.id);
      merged++;
    } else {
      const desc =
        finding.exampleComment ??
        `${finding.category} in ${finding.module}`;
      saveConvention(db, {
        module: finding.module,
        pattern: finding.pattern,
        description: desc,
        confidence: Math.min(1.0, 0.5 + finding.occurrenceCount * 0.05),
        source: "review",
        occurrences: finding.occurrenceCount,
        lastSeen: finding.lastSeen,
      });
      merged++;
    }
  }

  return merged;
}

export function recordConventionCompliance(
  db: KGDatabase,
  conventionId: number,
  followed: boolean,
  runId: string,
): void {
  ensureConventionTables(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO kg_convention_compliance (convention_id, followed, run_id, timestamp)
     VALUES (?, ?, ?, ?)`,
  ).run(conventionId, followed ? 1 : 0, runId, now);
}

export function formatConventionsForContext(conventions: Convention[]): string {
  if (conventions.length === 0) return "";

  const lines: string[] = ["## Conventions"];
  lines.push(
    "The following coding conventions apply to the modules you are working in:",
  );

  const byModule = new Map<string, Convention[]>();
  for (const conv of conventions) {
    const existing = byModule.get(conv.module) ?? [];
    existing.push(conv);
    byModule.set(conv.module, existing);
  }

  for (const [mod, convs] of byModule) {
    const label = mod === "*" ? "Global" : `When working in ${mod}/`;
    const descs = convs.map((c) => c.description).join(". ");
    lines.push(`- ${label}: ${descs}`);
  }

  return lines.join("\n");
}

function deserializeConvention(row: {
  id: number;
  module: string;
  pattern: string;
  description: string;
  confidence: number;
  source: string;
  occurrences: number;
  last_seen: string;
}): Convention {
  return {
    id: row.id,
    module: row.module,
    pattern: row.pattern,
    description: row.description,
    confidence: row.confidence,
    source: row.source as Convention["source"],
    occurrences: row.occurrences,
    lastSeen: row.last_seen,
  };
}

export function extractModulePrefixes(filePaths: string[]): string[] {
  const prefixes = new Set<string>();
  for (const p of filePaths) {
    const parts = p.split("/");
    // Extract directory-based prefixes (drop the filename)
    const dirParts = parts.slice(0, -1);
    for (let i = 1; i <= dirParts.length; i++) {
      prefixes.add(dirParts.slice(0, i).join("/"));
    }
  }
  return [...prefixes];
}
