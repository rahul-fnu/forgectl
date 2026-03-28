import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import type { ForgectlConfig } from "./schema.js";

export type DetectedStack = "node" | "typescript" | "python" | "go" | "rust";

export interface StackDetectionResult {
  stack: DetectedStack;
  validationSteps: Array<{ name: string; command: string }>;
  image: string;
}

const STACK_IMAGES: Record<DetectedStack, string> = {
  typescript: "forgectl/code:latest",
  node: "forgectl/code:latest",
  python: "forgectl/code-python312:latest",
  go: "forgectl/code-go:latest",
  rust: "forgectl/code-rust:latest",
};

export function detectStackFromDir(dir: string): StackDetectionResult | null {
  const detected: DetectedStack[] = [];

  const hasPackageJson = existsSync(join(dir, "package.json"));
  const hasTsConfig = existsSync(join(dir, "tsconfig.json"));
  const hasPyprojectToml = existsSync(join(dir, "pyproject.toml"));
  const hasRequirementsTxt = existsSync(join(dir, "requirements.txt"));
  const hasGoMod = existsSync(join(dir, "go.mod"));
  const hasCargoToml = existsSync(join(dir, "Cargo.toml"));

  if (hasPackageJson) {
    detected.push(hasTsConfig ? "typescript" : "node");
  }
  if (hasPyprojectToml || hasRequirementsTxt) {
    detected.push("python");
  }
  if (hasGoMod) {
    detected.push("go");
  }
  if (hasCargoToml) {
    detected.push("rust");
  }

  if (detected.length === 0) return null;

  const stack = detected[0];
  const validationSteps = detectValidationSteps(dir, stack);

  return { stack, validationSteps, image: STACK_IMAGES[stack] };
}

function detectValidationSteps(
  dir: string,
  stack: DetectedStack,
): Array<{ name: string; command: string }> {
  const steps: Array<{ name: string; command: string }> = [];

  if (stack === "node" || stack === "typescript") {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const scripts = pkg.scripts ?? {};
        if (scripts.build) steps.push({ name: "build", command: "npm run build" });
        if (scripts.lint) steps.push({ name: "lint", command: "npm run lint" });
        if (scripts.typecheck) steps.push({ name: "typecheck", command: "npm run typecheck" });
        if (scripts.test) steps.push({ name: "test", command: "npm test" });
      } catch {
        // ignore malformed package.json
      }
    }
  } else if (stack === "python") {
    const deps = readPythonDeps(dir);
    if (deps.includes("ruff")) steps.push({ name: "lint", command: "ruff check ." });
    if (deps.includes("mypy")) steps.push({ name: "typecheck", command: "mypy ." });
    if (deps.includes("pytest")) steps.push({ name: "test", command: "pytest" });
  } else if (stack === "go") {
    const hasGolangciConfig =
      existsSync(join(dir, ".golangci.yml")) ||
      existsSync(join(dir, ".golangci.yaml")) ||
      existsSync(join(dir, ".golangci.toml"));
    if (hasGolangciConfig) steps.push({ name: "lint", command: "golangci-lint run" });
    steps.push({ name: "test", command: "go test ./..." });
  } else if (stack === "rust") {
    steps.push({ name: "clippy", command: "cargo clippy -- -D warnings" });
    steps.push({ name: "test", command: "cargo test" });
  }

  return steps;
}

function readPythonDeps(dir: string): string[] {
  const deps: string[] = [];

  const pyprojectPath = join(dir, "pyproject.toml");
  if (existsSync(pyprojectPath)) {
    const content = readFileSync(pyprojectPath, "utf-8");
    deps.push(...extractPyprojectDeps(content));
  }

  const requirementsPath = join(dir, "requirements.txt");
  if (existsSync(requirementsPath)) {
    const content = readFileSync(requirementsPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const name = trimmed.split(/[><=!~\[]/)[0].trim().toLowerCase();
        if (name) deps.push(name);
      }
    }
  }

  return deps;
}

function extractPyprojectDeps(content: string): string[] {
  const deps: string[] = [];
  const depPatterns = [/dependencies\s*=\s*\[([\s\S]*?)\]/g, /dev-dependencies\s*=\s*\[([\s\S]*?)\]/g];
  for (const pattern of depPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const block = match[1];
      for (const line of block.split("\n")) {
        const trimmed = line.replace(/[",]/g, "").trim();
        if (trimmed) {
          const name = trimmed.split(/[><=!~\[]/)[0].trim().toLowerCase();
          if (name) deps.push(name);
        }
      }
    }
  }
  return deps;
}

function installCommand(stack: DetectedStack): string {
  switch (stack) {
    case "node":
    case "typescript":
      return "npm install";
    case "python":
      return "pip install -e '.[dev]' 2>/dev/null || pip install -r requirements.txt 2>/dev/null || true";
    case "go":
      return "go mod download";
    case "rust":
      return "cargo fetch";
  }
}

export function buildProfileYaml(
  repoSlug: string,
  detection: StackDetectionResult,
): string {
  const install = installCommand(detection.stack);
  const profile: Record<string, unknown> = {
    workspace: {
      hooks: {
        after_create: `git clone --depth 1 https://{{GITHUB_TOKEN}}@github.com/${repoSlug}.git .`,
        before_run: `git checkout main && git pull && ${install}`,
      },
    },
    tracker: {
      repo: repoSlug,
    },
    container: {
      image: detection.image,
    },
  };

  if (detection.validationSteps.length > 0) {
    (profile as any).validation = {
      steps: detection.validationSteps.map((s) => ({
        name: s.name,
        command: s.command,
      })),
    };
  }

  return yaml.dump(profile, { lineWidth: 120 });
}

export async function autoGenerateProfile(
  repoSlug: string,
): Promise<Partial<ForgectlConfig> | null> {
  const token = process.env.GITHUB_TOKEN;
  const repoUrl = token
    ? `https://${token}@github.com/${repoSlug}.git`
    : `https://github.com/${repoSlug}.git`;
  const tmpDir = join(tmpdir(), `forgectl-autodetect-${Date.now()}`);

  try {
    mkdirSync(tmpDir, { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", repoUrl, tmpDir], {
      stdio: "pipe",
      timeout: 30_000,
    });

    const detection = detectStackFromDir(tmpDir);
    if (!detection) return null;

    const profileYaml = buildProfileYaml(repoSlug, detection);

    const home = process.env.HOME || process.env.USERPROFILE || "";
    const reposDir = join(home, ".forgectl", "repos");
    mkdirSync(reposDir, { recursive: true });

    const repoName = repoSlug.split("/")[1];
    const profilePath = join(reposDir, `${repoName}.yaml`);
    writeFileSync(profilePath, profileYaml, "utf-8");

    const { loadRepoProfile } = await import("./loader.js");
    return loadRepoProfile(repoName) as Partial<ForgectlConfig>;
  } catch {
    return null;
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
}
