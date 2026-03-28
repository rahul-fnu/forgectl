import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Octokit } from "@octokit/core";
import type { DetectedStack } from "../config/auto-profile.js";
import { scaffoldPython } from "./scaffolds/scaffold-python.js";
import { scaffoldNode } from "./scaffolds/scaffold-node.js";
import { scaffoldGo } from "./scaffolds/scaffold-go.js";
import { scaffoldRust } from "./scaffolds/scaffold-rust.js";

export interface CreateProjectOptions {
  name: string;
  description?: string;
  private?: boolean;
  stack: DetectedStack;
  org?: string;
}

export interface CreateProjectResult {
  repoSlug: string;
  cloneUrl: string;
  htmlUrl: string;
}

export async function createGitHubRepo(
  octokit: Octokit,
  opts: CreateProjectOptions,
): Promise<CreateProjectResult> {
  const repoParams = {
    name: opts.name,
    description: opts.description ?? "",
    private: opts.private ?? true,
    auto_init: false,
  };

  let data: { full_name: string; clone_url: string; html_url: string };

  if (opts.org) {
    const res = await (octokit as any).rest.repos.createInOrg({
      org: opts.org,
      ...repoParams,
    });
    data = res.data;
  } else {
    const res = await (octokit as any).rest.repos.createForAuthenticatedUser(repoParams);
    data = res.data;
  }

  return {
    repoSlug: data.full_name,
    cloneUrl: data.clone_url,
    htmlUrl: data.html_url,
  };
}

export function scaffoldProject(dir: string, opts: CreateProjectOptions): void {
  const { name, stack } = opts;

  switch (stack) {
    case "python":
      scaffoldPython(dir, name);
      break;
    case "node":
    case "typescript":
      scaffoldNode(dir, name);
      break;
    case "go":
      scaffoldGo(dir, name, `github.com/${opts.org ?? "user"}/${name}`);
      break;
    case "rust":
      scaffoldRust(dir, name);
      break;
  }
}

export function initAndPush(dir: string, remoteUrl: string): void {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });

  run(["init"]);
  run(["add", "."]);
  run(["commit", "-m", "Initial scaffold"]);
  run(["branch", "-M", "main"]);
  run(["remote", "add", "origin", remoteUrl]);
  run(["push", "-u", "origin", "main"]);
}

export async function createProject(
  octokit: Octokit,
  opts: CreateProjectOptions,
): Promise<CreateProjectResult> {
  const result = await createGitHubRepo(octokit, opts);

  const tmpDir = join(tmpdir(), `forgectl-scaffold-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    scaffoldProject(tmpDir, opts);
    initAndPush(tmpDir, result.cloneUrl);

    const { autoGenerateProfile } = await import("../config/auto-profile.js");
    await autoGenerateProfile(result.repoSlug);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }

  return result;
}
