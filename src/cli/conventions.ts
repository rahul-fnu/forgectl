import chalk from "chalk";
import { createKGDatabase, resolveKGPath } from "../kg/storage.js";
import {
  listConventions,
  getConventionsForModule,
  ignoreConvention,
  refreshConventionsFromFindings,
  type Convention,
} from "../kg/conventions.js";
import { closeDatabase, createDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/migrator.js";
import { createReviewFindingsRepository } from "../storage/repositories/review-findings.js";

export async function conventionsListCommand(options: { db?: string; workspace?: string }): Promise<void> {
  const db = createKGDatabase(resolveKGPath(options.workspace, options.db));
  try {
    const conventions = listConventions(db);
    if (conventions.length === 0) {
      console.log(chalk.yellow("No conventions discovered yet."));
      console.log(chalk.dim("Run 'forgectl conventions refresh' to analyze the codebase."));
      return;
    }

    console.log(chalk.bold.white(`\nDiscovered Conventions (${conventions.length})\n`));
    for (const c of conventions) {
      printConvention(c);
    }
    console.log();
  } finally {
    db.close();
  }
}

export async function conventionsShowCommand(module: string, options: { db?: string; workspace?: string }): Promise<void> {
  const db = createKGDatabase(resolveKGPath(options.workspace, options.db));
  try {
    const conventions = getConventionsForModule(db, module);
    if (conventions.length === 0) {
      console.log(chalk.yellow(`No conventions found for module: ${module}`));
      return;
    }

    console.log(chalk.bold.white(`\nConventions for ${module} (${conventions.length})\n`));
    for (const c of conventions) {
      printConvention(c);
    }
    console.log();
  } finally {
    db.close();
  }
}

export async function conventionsIgnoreCommand(pattern: string, options: { db?: string; workspace?: string }): Promise<void> {
  const db = createKGDatabase(resolveKGPath(options.workspace, options.db));
  try {
    const count = ignoreConvention(db, pattern);
    if (count === 0) {
      console.log(chalk.yellow(`No conventions matched pattern: ${pattern}`));
    } else {
      console.log(chalk.green(`Ignored ${count} convention(s) matching "${pattern}"`));
    }
  } finally {
    db.close();
  }
}

export async function conventionsRefreshCommand(options: { db?: string; workspace?: string }): Promise<void> {
  const kgDb = createKGDatabase(resolveKGPath(options.workspace, options.db));

  let appDb;
  try {
    appDb = createDatabase();
    runMigrations(appDb);
    const findingsRepo = createReviewFindingsRepository(appDb);
    const findings = findingsRepo.findAll();

    console.log(chalk.blue(`Found ${findings.length} review findings. Syncing to conventions...`));
    const count = refreshConventionsFromFindings(kgDb, findings);
    console.log(chalk.green(`Synced ${count} convention(s) from review findings.`));
  } finally {
    kgDb.close();
    if (appDb) closeDatabase(appDb);
  }
}

function printConvention(c: Convention): void {
  const status = c.ignored ? chalk.red("[ignored]") : chalk.green("[active]");
  const confidence = chalk.dim(`(confidence: ${(c.confidence * 100).toFixed(0)}%)`);
  console.log(`  ${status} ${chalk.cyan(c.category)} ${confidence}`);
  console.log(`    ${c.description}`);
  console.log(`    ${chalk.dim(`module: ${c.module}  source: ${c.source}`)}`);
}
