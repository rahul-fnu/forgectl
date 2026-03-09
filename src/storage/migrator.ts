import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppDatabase } from "./database.js";

/**
 * Run all pending Drizzle migrations against the database.
 *
 * Migrations are idempotent — calling this multiple times is safe.
 *
 * The migration folder is resolved relative to this file:
 * - From src/storage/: ../../drizzle (development)
 * - From dist/: ../drizzle (production, copied by tsup onSuccess)
 */
export function runMigrations(db: AppDatabase, migrationsPath?: string): void {
  const resolvedPath = migrationsPath ?? findMigrationsFolder();
  migrate(db, { migrationsFolder: resolvedPath });
}

function findMigrationsFolder(): string {
  // import.meta.dirname is the directory of this file at runtime
  const dir = import.meta.dirname;

  // Development: src/storage/ -> ../../drizzle
  const devPath = join(dir, "..", "..", "drizzle");
  if (existsSync(devPath)) {
    return devPath;
  }

  // Production: dist/ -> ../drizzle (copied by tsup onSuccess)
  const distPath = join(dir, "..", "drizzle");
  if (existsSync(distPath)) {
    return distPath;
  }

  // Fallback to project root drizzle/
  const rootPath = join(dir, "drizzle");
  if (existsSync(rootPath)) {
    return rootPath;
  }

  throw new Error(
    `Cannot find drizzle migrations folder. Searched:\n  ${devPath}\n  ${distPath}\n  ${rootPath}`
  );
}
