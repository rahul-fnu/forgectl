import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as schema from "./schema.js";

/**
 * Create a Drizzle ORM database instance backed by SQLite.
 *
 * Configures WAL journal mode, foreign keys, and a 5-second busy timeout.
 * If no path is provided, defaults to ~/.forgectl/forgectl.db.
 */
export function createDatabase(dbPath?: string) {
  const resolvedPath =
    dbPath ?? join(process.env.HOME || "/tmp", ".forgectl", "forgectl.db");

  mkdirSync(dirname(resolvedPath), { recursive: true });

  const sqlite = new Database(resolvedPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  return drizzle(sqlite, { schema });
}

/** The Drizzle database type with schema attached. */
export type AppDatabase = ReturnType<typeof createDatabase>;

/**
 * Close the underlying SQLite connection.
 *
 * Access the raw better-sqlite3 Database via the `$client` property
 * on the Drizzle instance.
 */
export function closeDatabase(db: AppDatabase): void {
  db.$client.close();
}
