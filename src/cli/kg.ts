import chalk from "chalk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildFullGraph, buildIncrementalGraph } from "../kg/builder.js";
import { createKGDatabase, getStats, getMeta, resolveKGPath } from "../kg/storage.js";
import type { KnowledgeGraphStats } from "../kg/types.js";
import { queryModule } from "../kg/query.js";

const execFileAsync = promisify(execFile);

/**
 * forgectl kg build — Full knowledge graph rebuild.
 */
export async function kgBuildCommand(options: { db?: string; workspace?: string }): Promise<void> {
  const repoPath = options.workspace ?? process.cwd();
  const dbPath = resolveKGPath(options.workspace, options.db);
  console.log(chalk.blue(`Building knowledge graph${options.workspace ? ` for workspace ${options.workspace}` : ""}...`));
  const start = Date.now();

  const stats = await buildFullGraph(repoPath, dbPath);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(chalk.green("\nKnowledge graph built successfully!"));
  printStats(stats);
  console.log(chalk.dim(`\nCompleted in ${elapsed}s`));
}

/**
 * forgectl kg update — Incremental update based on git changes since last build.
 */
export async function kgUpdateCommand(options: { db?: string; workspace?: string }): Promise<void> {
  const repoPath = options.workspace ?? process.cwd();
  const dbPath = resolveKGPath(options.workspace, options.db);

  // Find last build time
  const db = createKGDatabase(dbPath);
  const lastBuild = getMeta(db, "last_full_build") || getMeta(db, "last_incremental");
  db.close();

  if (!lastBuild) {
    console.log(chalk.yellow("No previous build found. Running full build..."));
    await kgBuildCommand(options);
    return;
  }

  // Get changed files since last build
  let changedFiles: string[];
  try {
    const { stdout } = await execFileAsync("git", [
      "diff", "--name-only", `--since=${lastBuild}`, "HEAD",
    ], { cwd: repoPath });
    changedFiles = stdout.trim().split("\n").filter(f =>
      f && (f.endsWith(".ts") || f.endsWith(".tsx"))
    );
  } catch {
    // Fallback: get recent changes
    try {
      const { stdout } = await execFileAsync("git", [
        "diff", "--name-only", "HEAD~10", "HEAD",
      ], { cwd: repoPath });
      changedFiles = stdout.trim().split("\n").filter(f =>
        f && (f.endsWith(".ts") || f.endsWith(".tsx"))
      );
    } catch {
      console.log(chalk.yellow("Could not determine changed files. Running full build..."));
      await kgBuildCommand(options);
      return;
    }
  }

  if (changedFiles.length === 0) {
    console.log(chalk.green("No TypeScript files changed since last build."));
    return;
  }

  console.log(chalk.blue(`Updating ${changedFiles.length} changed files...`));
  const start = Date.now();

  const stats = await buildIncrementalGraph(repoPath, changedFiles, dbPath);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(chalk.green("\nKnowledge graph updated!"));
  printStats(stats);
  console.log(chalk.dim(`\nCompleted in ${elapsed}s`));
}

/**
 * forgectl kg query <module> — Show module dependencies, coupling, test coverage.
 */
export async function kgQueryCommand(modulePath: string, options: { db?: string; workspace?: string }): Promise<void> {
  const db = createKGDatabase(resolveKGPath(options.workspace, options.db));

  try {
    const result = queryModule(db, modulePath);
    if (!result) {
      console.log(chalk.red(`Module not found: ${modulePath}`));
      console.log(chalk.dim("Run 'forgectl kg build' first to build the knowledge graph."));
      return;
    }

    // Module info
    console.log(chalk.bold.white(`\n${result.module.path}`));
    console.log(chalk.dim(`  Test file: ${result.module.isTest ? "yes" : "no"}`));

    // Exports
    if (result.module.exports.length > 0) {
      console.log(chalk.yellow("\n  Exports:"));
      for (const exp of result.module.exports) {
        console.log(`    ${chalk.cyan(exp.kind.padEnd(10))} ${exp.name}`);
      }
    }

    // Dependencies (what it imports)
    if (result.dependencies.length > 0) {
      console.log(chalk.yellow(`\n  Dependencies (${result.dependencies.length}):`));
      for (const dep of result.dependencies) {
        console.log(`    ${chalk.dim("→")} ${dep}`);
      }
    }

    // Dependents (who imports it)
    if (result.dependents.length > 0) {
      console.log(chalk.yellow(`\n  Direct Dependents (${result.dependents.length}):`));
      for (const dep of result.dependents) {
        console.log(`    ${chalk.dim("←")} ${dep}`);
      }
    }

    // Transitive dependents
    if (result.transitiveDependents.length > result.dependents.length) {
      console.log(chalk.yellow(`\n  Transitive Impact (${result.transitiveDependents.length} files):`));
      const extra = result.transitiveDependents.filter(d => !result.dependents.includes(d));
      for (const dep of extra.slice(0, 10)) {
        console.log(`    ${chalk.dim("⇐")} ${dep}`);
      }
      if (extra.length > 10) {
        console.log(chalk.dim(`    ... and ${extra.length - 10} more`));
      }
    }

    // Test coverage
    if (result.testCoverage.length > 0) {
      console.log(chalk.yellow("\n  Test Coverage:"));
      for (const tc of result.testCoverage) {
        for (const tf of tc.testFiles) {
          console.log(`    ${chalk.green("✓")} ${tf} ${chalk.dim(`(${tc.confidence})`)}`);
        }
      }
    } else {
      console.log(chalk.red("\n  Test Coverage: none"));
    }

    // Change coupling
    if (result.changeCoupling.length > 0) {
      console.log(chalk.yellow("\n  Change Coupling:"));
      for (const cc of result.changeCoupling.slice(0, 10)) {
        const other = cc.fileA === modulePath ? cc.fileB : cc.fileA;
        const pct = (cc.couplingScore * 100).toFixed(0);
        console.log(`    ${chalk.magenta(`${pct}%`)} ${other} ${chalk.dim(`(${cc.cochangeCount} co-changes)`)}`);
      }
    }

    console.log();
  } finally {
    db.close();
  }
}

/**
 * forgectl kg stats — Show graph statistics.
 */
export async function kgStatsCommand(options: { db?: string; workspace?: string }): Promise<void> {
  const db = createKGDatabase(resolveKGPath(options.workspace, options.db));

  try {
    const stats = getStats(db);
    console.log(chalk.bold.white("\nKnowledge Graph Statistics"));
    printStats(stats);
    console.log();
  } finally {
    db.close();
  }
}

/**
 * forgectl kg status — Show root hash and change summary.
 */
export async function kgStatusCommand(options: { db?: string; workspace?: string }): Promise<void> {
  const db = createKGDatabase(resolveKGPath(options.workspace, options.db));

  try {
    const stats = getStats(db);
    const rootHash = getMeta(db, "root_hash");
    const lastRootHash = getMeta(db, "last_root_hash");

    console.log(chalk.bold.white("\nKnowledge Graph Status"));

    if (rootHash) {
      console.log(`  ${chalk.dim("Root Hash:")}     ${rootHash}`);
    } else {
      console.log(chalk.yellow("  No root hash computed. Run 'forgectl kg build' first."));
    }

    if (rootHash && lastRootHash) {
      if (rootHash === lastRootHash) {
        console.log(chalk.green("  Cache: full hit (no semantic changes since last build)"));
      } else {
        console.log(chalk.yellow("  Cache: invalidated (semantic changes detected)"));
      }
    }

    if (stats.changedSinceLastBuild !== undefined) {
      console.log(`  ${chalk.dim("Changed modules:")} ${stats.changedSinceLastBuild}`);
    }

    console.log(`  ${chalk.dim("Total modules:")}  ${stats.totalModules}`);

    if (stats.lastFullBuild) {
      console.log(`  ${chalk.dim("Last Full Build:")} ${stats.lastFullBuild}`);
    }
    if (stats.lastIncremental) {
      console.log(`  ${chalk.dim("Last Incremental:")} ${stats.lastIncremental}`);
    }

    console.log();
  } finally {
    db.close();
  }
}

function printStats(stats: KnowledgeGraphStats): void {
  console.log(`  ${chalk.dim("Modules:")}       ${stats.totalModules}`);
  console.log(`  ${chalk.dim("Edges:")}         ${stats.totalEdges}`);
  console.log(`  ${chalk.dim("Test Mappings:")} ${stats.totalTestMappings}`);
  console.log(`  ${chalk.dim("Coupling Pairs:")} ${stats.totalCouplingPairs}`);
  if (stats.rootHash) {
    console.log(`  ${chalk.dim("Root Hash:")}     ${stats.rootHash}`);
  }
  if (stats.changedSinceLastBuild !== undefined) {
    console.log(`  ${chalk.dim("Changed Since Last Build:")} ${stats.changedSinceLastBuild}`);
  }
  if (stats.lastFullBuild) {
    console.log(`  ${chalk.dim("Last Full Build:")} ${stats.lastFullBuild}`);
  }
  if (stats.lastIncremental) {
    console.log(`  ${chalk.dim("Last Incremental:")} ${stats.lastIncremental}`);
  }
}
