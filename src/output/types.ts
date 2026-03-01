export interface GitResult {
  mode: "git";
  branch: string;
  sha: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface FileResult {
  mode: "files";
  dir: string;
  files: string[];
  totalSize: number;
}

export type OutputResult = GitResult | FileResult;
