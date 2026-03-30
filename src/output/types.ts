export interface GitResult {
  mode: "git";
  branch: string;
  sha: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  diffStat?: string;
}

export interface FilesResult {
  mode: "files";
  dir: string;
  files: string[];
  totalSize: number;
}

export type OutputResult = GitResult | FilesResult;
