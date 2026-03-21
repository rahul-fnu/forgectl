import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { listRepoProfiles, loadRepoProfile } from "../config/loader.js";

export async function repoListCommand(): Promise<void> {
  const profiles = listRepoProfiles();

  if (profiles.length === 0) {
    console.log("No repo profiles found.");
    console.log("");
    console.log("Add one with:");
    console.log("  forgectl repo add <name> --tracker-repo <owner/repo>          # GitHub");
    console.log("  forgectl repo add <name> --linear --team-id <uuid>            # Linear");
    return;
  }

  console.log("Repo profiles:");
  for (const p of profiles) {
    const detail = p.trackerRepo ? `  (${p.trackerRepo})` : p.trackerKind ? `  (${p.trackerKind})` : "";
    console.log(`  ${p.name}${detail}`);
  }
}

export async function repoAddCommand(
  name: string,
  opts: {
    trackerRepo?: string;
    labels?: string;
    token?: string;
    linear?: boolean;
    teamId?: string[];
    projectId?: string;
    webhookSecret?: string;
  },
): Promise<void> {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const reposDir = join(home, ".forgectl", "repos");

  if (!existsSync(reposDir)) {
    mkdirSync(reposDir, { recursive: true });
  }

  const profilePath = join(reposDir, `${name}.yaml`);

  let overlay: Record<string, unknown>;

  if (opts.linear) {
    // Linear tracker profile
    if (!opts.teamId || opts.teamId.length === 0) {
      console.error("Error: --team-id is required for Linear profiles (use --team-id <uuid>, repeatable)");
      process.exit(1);
    }

    overlay = {
      tracker: {
        kind: "linear",
        token: opts.token || "$linear",
        team_ids: opts.teamId,
        ...(opts.projectId ? { project_id: opts.projectId } : {}),
        ...(opts.webhookSecret ? { webhook_secret: opts.webhookSecret } : {}),
        ...(opts.labels ? { labels: opts.labels.split(",").map((l) => l.trim()) } : {}),
        active_states: ["In Progress", "Todo"],
        terminal_states: ["Done", "Canceled"],
      },
    };

    writeFileSync(profilePath, yaml.dump(overlay, { lineWidth: 120 }), "utf-8");
    console.log(`Created Linear repo profile: ${profilePath}`);
    console.log("");
    console.log("Make sure LINEAR_API_KEY is set in your environment:");
    console.log("  export LINEAR_API_KEY=lin_api_...");
    console.log("");
    console.log(`Start the orchestrator with:`);
    console.log(`  forgectl orchestrate --repo ${name}`);
  } else {
    // GitHub tracker profile (default)
    if (!opts.trackerRepo) {
      console.error("Error: --tracker-repo is required for GitHub profiles");
      process.exit(1);
    }

    overlay = {
      tracker: {
        kind: "github",
        repo: opts.trackerRepo,
        token: opts.token || "$gh",
        ...(opts.labels ? { labels: opts.labels.split(",").map((l) => l.trim()) } : {}),
      },
    };

    writeFileSync(profilePath, yaml.dump(overlay, { lineWidth: 120 }), "utf-8");
    console.log(`Created GitHub repo profile: ${profilePath}`);
    console.log(`Use with: forgectl orchestrate --repo ${name}`);
  }
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
