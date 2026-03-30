import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

export interface FileSnapshot {
  totalFiles: number;
  timestamp: string;
}

export interface EvolutionCheck {
  needsUpdate: boolean;
  reason: string | null;
  currentFileCount: number;
  baselineFileCount: number;
}

const SNAPSHOT_FILE = ".forgectl/claude-md-snapshot.json";

const EXCLUDED_DIRS = new Set([
  "node_modules", "dist", "build", ".git", ".next", "coverage",
  "target", "__pycache__", ".mypy_cache", ".ruff_cache", ".pytest_cache",
  ".venv", "venv", ".tox", "vendor", ".cache",
]);

const EXCLUDED_EXTENSIONS = new Set([
  ".log", ".lock", ".pyc", ".o", ".so", ".dylib", ".exe", ".dll",
  ".class", ".rlib", ".wasm", ".map",
]);

/**
 * Count source files in a directory tree, excluding build artifacts and dependencies.
 */
export function countSourceFiles(dir: string): number {
  let count = 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    if (EXCLUDED_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countSourceFiles(fullPath);
    } else if (entry.isFile()) {
      const ext = entry.name.includes(".") ? "." + entry.name.split(".").pop()! : "";
      if (!EXCLUDED_EXTENSIONS.has(ext)) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Read the stored file snapshot for a workspace.
 */
export function readSnapshot(workspaceDir: string): FileSnapshot | null {
  const snapshotPath = join(workspaceDir, SNAPSHOT_FILE);
  if (!existsSync(snapshotPath)) return null;
  try {
    return JSON.parse(readFileSync(snapshotPath, "utf-8")) as FileSnapshot;
  } catch {
    return null;
  }
}

/**
 * Write a file snapshot for a workspace.
 */
export function writeSnapshot(workspaceDir: string, snapshot: FileSnapshot): void {
  const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const dir = join(workspaceDir, ".forgectl");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(workspaceDir, SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2) + "\n");
}

/**
 * Check whether CLAUDE.md needs an update based on:
 * 1. Time elapsed (30 days since last snapshot)
 * 2. File growth (20%+ increase)
 */
export function checkEvolution(workspaceDir: string): EvolutionCheck {
  const currentCount = countSourceFiles(workspaceDir);
  const snapshot = readSnapshot(workspaceDir);

  if (!snapshot) {
    return {
      needsUpdate: false,
      reason: null,
      currentFileCount: currentCount,
      baselineFileCount: 0,
    };
  }

  const daysSinceSnapshot = (Date.now() - new Date(snapshot.timestamp).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceSnapshot >= 30) {
    return {
      needsUpdate: true,
      reason: `${Math.floor(daysSinceSnapshot)} days since last CLAUDE.md update`,
      currentFileCount: currentCount,
      baselineFileCount: snapshot.totalFiles,
    };
  }

  if (snapshot.totalFiles > 0) {
    const growthRatio = (currentCount - snapshot.totalFiles) / snapshot.totalFiles;
    if (growthRatio >= 0.2) {
      const pct = Math.round(growthRatio * 100);
      return {
        needsUpdate: true,
        reason: `${pct}% file growth (${snapshot.totalFiles} -> ${currentCount})`,
        currentFileCount: currentCount,
        baselineFileCount: snapshot.totalFiles,
      };
    }
  }

  return {
    needsUpdate: false,
    reason: null,
    currentFileCount: currentCount,
    baselineFileCount: snapshot.totalFiles,
  };
}

/**
 * Detect the project stack from files present in the directory.
 */
function detectStack(dir: string): string {
  if (existsSync(join(dir, "package.json"))) {
    if (existsSync(join(dir, "tsconfig.json"))) return "TypeScript/Node.js";
    return "Node.js";
  }
  if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "setup.py"))) return "Python";
  if (existsSync(join(dir, "go.mod"))) return "Go";
  if (existsSync(join(dir, "Cargo.toml"))) return "Rust";
  return "Unknown";
}

/**
 * Collect top-level directory names (source structure).
 */
function listTopLevelDirs(dir: string): string[] {
  const dirs: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !EXCLUDED_DIRS.has(entry.name)) {
        dirs.push(entry.name + "/");
      }
    }
  } catch { /* ignore */ }
  return dirs.sort();
}

/**
 * Detect build/test commands from project config files.
 */
function detectCommands(dir: string): { build: string[]; test: string[]; lint: string[] } {
  const build: string[] = [];
  const test: string[] = [];
  const lint: string[] = [];

  // package.json
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts ?? {};
      if (scripts.build) build.push("npm run build");
      if (scripts.test) test.push("npm test");
      if (scripts.lint) lint.push("npm run lint");
      if (scripts.typecheck) lint.push("npm run typecheck");
    } catch { /* ignore */ }
  }

  // pyproject.toml
  if (existsSync(join(dir, "pyproject.toml"))) {
    test.push("pytest");
    lint.push("ruff check .");
  }

  // go.mod
  if (existsSync(join(dir, "go.mod"))) {
    build.push("go build ./...");
    test.push("go test ./...");
    lint.push("go vet ./...");
  }

  // Cargo.toml
  if (existsSync(join(dir, "Cargo.toml"))) {
    build.push("cargo build");
    test.push("cargo test");
    lint.push("cargo clippy");
  }

  return { build, test, lint };
}

/**
 * Generate CLAUDE.md content for a project directory.
 */
export function generateClaudeMd(dir: string, projectName?: string): string {
  const name = projectName ?? dir.split("/").pop() ?? "project";
  const stack = detectStack(dir);
  const topDirs = listTopLevelDirs(dir);
  const commands = detectCommands(dir);

  const lines: string[] = [];
  lines.push(`# CLAUDE.md -- ${name}`);
  lines.push("");
  lines.push("## Project Overview");
  lines.push(`This is a ${stack} project.`);
  lines.push("");

  if (topDirs.length > 0) {
    lines.push("## Project Structure");
    lines.push("```");
    for (const d of topDirs) {
      lines.push(d);
    }
    lines.push("```");
    lines.push("");
  }

  lines.push("## Commands");
  if (commands.build.length > 0 || commands.test.length > 0 || commands.lint.length > 0) {
    lines.push("```bash");
    for (const cmd of commands.build) lines.push(`${cmd}    # Build`);
    for (const cmd of commands.test) lines.push(`${cmd}    # Test`);
    for (const cmd of commands.lint) lines.push(`${cmd}    # Lint`);
    lines.push("```");
  } else {
    lines.push("No standard build commands detected.");
  }
  lines.push("");

  lines.push("## Conventions");
  lines.push("- Follow existing code style and patterns");
  lines.push("- Write tests for new functionality");
  lines.push("- Keep changes focused and minimal");
  lines.push("");

  return lines.join("\n");
}

/**
 * Record a baseline snapshot after generating or updating CLAUDE.md.
 */
export function recordBaseline(workspaceDir: string): void {
  const count = countSourceFiles(workspaceDir);
  writeSnapshot(workspaceDir, {
    totalFiles: count,
    timestamp: new Date().toISOString(),
  });
}
