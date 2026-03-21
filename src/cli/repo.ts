import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { listRepoProfiles, loadRepoProfile } from "../config/loader.js";

export async function repoListCommand(): Promise<void> {
  const profiles = listRepoProfiles();

  if (profiles.length === 0) {
    console.log("No repo profiles found.");
    console.log("Add one with: forgectl repo add <name> --tracker-repo <owner/repo>");
    return;
  }

  console.log("Repo profiles:");
  for (const p of profiles) {
    const repo = p.trackerRepo ? `  (${p.trackerRepo})` : "";
    console.log(`  ${p.name}${repo}`);
  }
}

export async function repoAddCommand(
  name: string,
  opts: { trackerRepo: string; labels?: string; token?: string },
): Promise<void> {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const reposDir = join(home, ".forgectl", "repos");

  if (!existsSync(reposDir)) {
    mkdirSync(reposDir, { recursive: true });
  }

  const profilePath = join(reposDir, `${name}.yaml`);

  const overlay: Record<string, unknown> = {
    tracker: {
      kind: "github",
      repo: opts.trackerRepo,
      token: opts.token || "$gh",
      ...(opts.labels ? { labels: opts.labels.split(",").map(l => l.trim()) } : {}),
    },
  };

  writeFileSync(profilePath, yaml.dump(overlay, { lineWidth: 120 }), "utf-8");
  console.log(`Created repo profile: ${profilePath}`);
  console.log(`Use with: forgectl orchestrate --repo ${name}`);
}

export async function repoShowCommand(name: string): Promise<void> {
  try {
    const config = loadRepoProfile(name);
    console.log(yaml.dump(config, { lineWidth: 120 }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
