import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import chalk from "chalk";
import { listRepoProfiles, loadRepoProfile } from "../config/loader.js";

export interface DetectedStack {
  language: string;
  tools: string[];
  image: string;
  validation: Array<{ name: string; command: string; retries: number }>;
}

export function detectStack(repoDir: string): DetectedStack {
  const has = (f: string) => existsSync(join(repoDir, f));

  if (has("package.json")) {
    const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf-8"));
    const tools: string[] = [];
    const validation: Array<{ name: string; command: string; retries: number }> = [];
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (pkg.scripts?.test) {
      tools.push("npm test");
      validation.push({ name: "test", command: "npm test", retries: 3 });
    }
    if (pkg.scripts?.lint) {
      tools.push("eslint");
      validation.push({ name: "lint", command: "npm run lint", retries: 3 });
    }
    if (pkg.scripts?.build) {
      validation.push({ name: "build", command: "npm run build", retries: 1 });
    }
    if (deps?.typescript || has("tsconfig.json")) {
      tools.push("typescript");
    }

    const isTS = tools.includes("typescript");
    return {
      language: isTS ? "TypeScript" : "Node.js",
      tools,
      image: "forgectl/code-node20",
      validation,
    };
  }

  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    const tools: string[] = [];
    const validation: Array<{ name: string; command: string; retries: number }> = [];

    const pyprojectExists = has("pyproject.toml");
    let pyprojectContent = "";
    if (pyprojectExists) {
      pyprojectContent = readFileSync(join(repoDir, "pyproject.toml"), "utf-8");
    }
    const reqExists = has("requirements.txt");
    let reqContent = "";
    if (reqExists) {
      reqContent = readFileSync(join(repoDir, "requirements.txt"), "utf-8");
    }
    const allContent = pyprojectContent + "\n" + reqContent;

    if (allContent.includes("pytest") || has("pytest.ini") || has("conftest.py")) {
      tools.push("pytest");
      validation.push({ name: "test", command: "pytest", retries: 3 });
    }
    if (allContent.includes("ruff")) {
      tools.push("ruff");
      validation.push({ name: "lint", command: "ruff check .", retries: 3 });
    }
    if (allContent.includes("mypy")) {
      tools.push("mypy");
      validation.push({ name: "typecheck", command: "mypy .", retries: 2 });
    }
    if (allContent.includes("black")) {
      tools.push("black");
    }
    if (allContent.includes("flake8")) {
      tools.push("flake8");
      if (!validation.some(v => v.name === "lint")) {
        validation.push({ name: "lint", command: "flake8 .", retries: 3 });
      }
    }

    return {
      language: "Python",
      tools,
      image: "forgectl/code-python312",
      validation,
    };
  }

  if (has("go.mod")) {
    const tools: string[] = ["go test"];
    const validation: Array<{ name: string; command: string; retries: number }> = [
      { name: "test", command: "go test ./...", retries: 3 },
    ];
    if (has(".golangci.yml") || has(".golangci.yaml")) {
      tools.push("golangci-lint");
      validation.push({ name: "lint", command: "golangci-lint run", retries: 3 });
    }
    return {
      language: "Go",
      tools,
      image: "forgectl/code-go122",
      validation,
    };
  }

  if (has("Cargo.toml")) {
    return {
      language: "Rust",
      tools: ["cargo test", "cargo clippy"],
      image: "forgectl/code-rust",
      validation: [
        { name: "test", command: "cargo test", retries: 3 },
        { name: "lint", command: "cargo clippy -- -D warnings", retries: 3 },
      ],
    };
  }

  return {
    language: "Unknown",
    tools: [],
    image: "forgectl/code-node20",
    validation: [],
  };
}

function formatDetection(stack: DetectedStack): string {
  const parts = [stack.language, "project"];
  if (stack.tools.length > 0) {
    parts.push("with");
    parts.push(stack.tools.join(", "));
  }
  return parts.join(" ");
}

export async function projectAddCommand(
  url: string,
): Promise<void> {
  // Parse owner/name from URL
  const match = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    console.error("Error: invalid GitHub URL. Expected https://github.com/owner/name");
    process.exit(1);
  }
  const owner = match[1];
  const repoName = match[2];
  const profileName = repoName;

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const reposDir = join(home, ".forgectl", "repos");
  const profilePath = join(reposDir, `${profileName}.yaml`);

  if (existsSync(profilePath)) {
    console.log(chalk.yellow(`Profile already exists: ${profilePath}`));
    return;
  }

  // 1. Shallow clone to temp dir
  const cloneDir = join(tmpdir(), `forgectl-detect-${profileName}-${Date.now()}`);
  console.log(`Cloning ${url} (shallow)...`);
  try {
    execFileSync("git", ["clone", "--depth", "1", url, cloneDir], {
      stdio: "pipe",
    });
  } catch (err) {
    console.error(`Error: failed to clone ${url}`);
    if (err instanceof Error && "stderr" in err) {
      console.error(String((err as any).stderr));
    }
    process.exit(1);
  }

  // 2. Detect stack
  const stack = detectStack(cloneDir);
  console.log(chalk.green(`Detected: ${formatDetection(stack)}`));

  // 3. Clean up clone
  rmSync(cloneDir, { recursive: true, force: true });

  // 4. Generate and save profile
  if (!existsSync(reposDir)) {
    mkdirSync(reposDir, { recursive: true });
  }

  const profile: Record<string, unknown> = {
    tracker: {
      kind: "github",
      repo: `${owner}/${repoName}`,
      token: "$gh",
    },
    container: {
      image: stack.image,
    },
  };

  if (stack.validation.length > 0) {
    profile.validation = {
      steps: stack.validation,
    };
  }

  writeFileSync(profilePath, yaml.dump(profile, { lineWidth: 120 }), "utf-8");
  console.log(`Saved profile: ${profilePath}`);
  console.log("");
  console.log(
    `Ready! Create issues with ${chalk.bold(`**Repo:** ${url}`)} in the description.`,
  );
}

export async function projectListCommand(): Promise<void> {
  const profiles = listRepoProfiles();

  if (profiles.length === 0) {
    console.log("No projects configured.");
    console.log("");
    console.log("Add one with:");
    console.log("  forgectl project add https://github.com/owner/name");
    return;
  }

  console.log("Configured projects:");
  for (const p of profiles) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const profilePath = join(home, ".forgectl", "repos", `${p.name}.yaml`);
    let stackInfo = "";
    try {
      const raw = readFileSync(profilePath, "utf-8");
      const parsed = yaml.load(raw) as Record<string, unknown> | null;
      const container = parsed?.container as Record<string, unknown> | undefined;
      const image = container?.image as string | undefined;
      if (image) {
        stackInfo = ` [${image}]`;
      }
    } catch { /* ignore */ }

    const repo = p.trackerRepo ? `  (${p.trackerRepo})` : "";
    console.log(`  ${p.name}${repo}${stackInfo}`);
  }
}

export async function projectShowCommand(name: string): Promise<void> {
  try {
    const config = loadRepoProfile(name);
    console.log(yaml.dump(config, { lineWidth: 120 }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
