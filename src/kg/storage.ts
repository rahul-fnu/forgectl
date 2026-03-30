import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ModuleInfo, TestCoverageMapping } from "./types.js";

export interface KGDatabase {
  close(): void;
  getModulePaths(): string[];
  getTestMappings(sourceFile: string): string[];
}

class KGDatabaseImpl implements KGDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS modules (
        path TEXT PRIMARY KEY,
        exports TEXT NOT NULL DEFAULT '[]',
        imports TEXT NOT NULL DEFAULT '[]',
        is_test INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS test_mappings (
        source_file TEXT NOT NULL,
        test_file TEXT NOT NULL,
        confidence TEXT NOT NULL DEFAULT 'medium',
        PRIMARY KEY (source_file, test_file)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  getModulePaths(): string[] {
    const rows = this.db.prepare("SELECT path FROM modules").all() as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  getTestMappings(sourceFile: string): string[] {
    const rows = this.db
      .prepare("SELECT test_file FROM test_mappings WHERE source_file = ?")
      .all(sourceFile) as Array<{ test_file: string }>;
    return rows.map((r) => r.test_file);
  }

  saveModules(modules: ModuleInfo[]): void {
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO modules (path, exports, imports, is_test) VALUES (?, ?, ?, ?)",
    );
    const tx = this.db.transaction(() => {
      for (const mod of modules) {
        insert.run(mod.path, JSON.stringify(mod.exports), JSON.stringify(mod.imports), mod.isTest ? 1 : 0);
      }
    });
    tx();
  }

  saveTestMappings(mappings: TestCoverageMapping[]): void {
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO test_mappings (source_file, test_file, confidence) VALUES (?, ?, ?)",
    );
    const tx = this.db.transaction(() => {
      for (const mapping of mappings) {
        for (const testFile of mapping.testFiles) {
          insert.run(mapping.sourceFile, testFile, mapping.confidence);
        }
      }
    });
    tx();
  }
}

export function createKGDatabase(dbPath: string): KGDatabase {
  return new KGDatabaseImpl(dbPath);
}

export function saveModules(db: KGDatabase, modules: ModuleInfo[]): void {
  (db as KGDatabaseImpl).saveModules(modules);
}

export function saveTestMappings(db: KGDatabase, mappings: TestCoverageMapping[]): void {
  (db as KGDatabaseImpl).saveTestMappings(mappings);
}
