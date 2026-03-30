export interface GitResult {
  mode: "git";
  branch: string;
  sha: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  diffStat?: string;
}

export type OutputResult = GitResult;
