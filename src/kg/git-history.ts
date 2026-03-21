import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChangeCoupling } from "./types.js";

const execFileAsync = promisify(execFile);

export interface ChangeCouplingOptions {
  since?: string;       // git date (e.g., "6 months ago")
  maxCommits?: number;  // limit number of commits analyzed
  minCochanges?: number; // minimum co-change count (default: 3)
  minScore?: number;     // minimum coupling score (default: 0.3)
}

/**
 * Analyze git history to find files that frequently change together.
 *
 * For each pair of files that changed in the same commit, increments their
 * co-change count. Coupling score = cochangeCount / min(commitsA, commitsB).
 */
export async function analyzeChangeCoupling(
  repoPath: string,
  options?: ChangeCouplingOptions,
): Promise<ChangeCoupling[]> {
  const minCochanges = options?.minCochanges ?? 3;
  const minScore = options?.minScore ?? 0.3;

  const commits = await getCommitFileLists(repoPath, options);

  // Count commits per file
  const fileCommitCount = new Map<string, number>();
  // Count co-changes per pair
  const pairCount = new Map<string, number>();

  for (const files of commits) {
    // Filter to TypeScript files only
    const tsFiles = files.filter(f =>
      f.endsWith('.ts') || f.endsWith('.tsx')
    );

    // Update per-file commit count
    for (const f of tsFiles) {
      fileCommitCount.set(f, (fileCommitCount.get(f) || 0) + 1);
    }

    // Update pair co-change count
    for (let i = 0; i < tsFiles.length; i++) {
      for (let j = i + 1; j < tsFiles.length; j++) {
        const key = makePairKey(tsFiles[i], tsFiles[j]);
        pairCount.set(key, (pairCount.get(key) || 0) + 1);
      }
    }
  }

  // Build coupling results
  const results: ChangeCoupling[] = [];

  for (const [key, count] of pairCount) {
    if (count < minCochanges) continue;

    const [fileA, fileB] = parsePairKey(key);
    const commitsA = fileCommitCount.get(fileA) || 0;
    const commitsB = fileCommitCount.get(fileB) || 0;
    const minCommits = Math.min(commitsA, commitsB);
    const score = minCommits > 0 ? count / minCommits : 0;

    if (score < minScore) continue;

    results.push({
      fileA,
      fileB,
      cochangeCount: count,
      totalCommits: commitsA + commitsB,
      couplingScore: Math.round(score * 1000) / 1000,
    });
  }

  // Sort by coupling score descending
  results.sort((a, b) => b.couplingScore - a.couplingScore);

  return results;
}

/**
 * Parse git log to get lists of files changed per commit.
 */
async function getCommitFileLists(
  repoPath: string,
  options?: ChangeCouplingOptions,
): Promise<string[][]> {
  const args = ['log', '--format=%H', '--name-only'];

  if (options?.since) {
    args.push(`--since=${options.since}`);
  }

  if (options?.maxCommits) {
    args.push(`-n`, String(options.maxCommits));
  }

  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large repos
  });

  const commits: string[][] = [];
  let currentFiles: string[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentFiles.length > 0) {
        commits.push(currentFiles);
        currentFiles = [];
      }
      continue;
    }

    // SHA lines are 40 hex chars
    if (/^[0-9a-f]{40}$/.test(trimmed)) {
      if (currentFiles.length > 0) {
        commits.push(currentFiles);
        currentFiles = [];
      }
    } else {
      currentFiles.push(trimmed);
    }
  }

  if (currentFiles.length > 0) {
    commits.push(currentFiles);
  }

  return commits;
}

function makePairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

function parsePairKey(key: string): [string, string] {
  const idx = key.indexOf('\0');
  return [key.substring(0, idx), key.substring(idx + 1)];
}
