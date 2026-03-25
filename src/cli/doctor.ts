import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface CheckResult {
  status: "pass" | "fail" | "warn";
  message: string;
  fix?: string;
}

const PASS = chalk.green("\u2714");
const FAIL = chalk.red("\u2718");
const WARN = chalk.yellow("!");

function formatResult(result: CheckResult): string {
  const icon = result.status === "pass" ? PASS : result.status === "fail" ? FAIL : WARN;
  const msg = result.status === "fail"
    ? chalk.red(result.message)
    : result.status === "warn"
      ? chalk.yellow(result.message)
      : chalk.green(result.message);
  let line = `  ${icon} ${msg}`;
  if (result.fix) {
    line += `\n    ${chalk.gray(result.fix)}`;
  }
  return line;
}

export async function checkNodeVersion(): Promise<CheckResult> {
  const major = parseInt(process.version.slice(1).split(".")[0], 10);
  if (major >= 20) {
    return { status: "pass", message: `Node.js ${process.version}` };
  }
  return {
    status: "fail",
    message: `Node.js ${process.version} (requires 20+)`,
    fix: "Install Node.js 20 or later: https://nodejs.org",
  };
}

export async function checkDocker(): Promise<CheckResult> {
  try {
    const Docker = (await import("dockerode")).default;
    const docker = new Docker();
    const info = await docker.version();
    const apiVersion = info.ApiVersion;
    const parts = apiVersion.split(".");
    const major = parseInt(parts[0], 10);
    const minor = parseInt(parts[1], 10);
    if (major > 1 || (major === 1 && minor >= 41)) {
      return { status: "pass", message: `Docker reachable (API ${apiVersion})` };
    }
    return {
      status: "fail",
      message: `Docker API version ${apiVersion} is too old (requires >= 1.41)`,
      fix: "Upgrade Docker to version 20.10+ (API 1.41+)",
    };
  } catch (err) {
    return {
      status: "fail",
      message: `Docker daemon not reachable: ${err instanceof Error ? err.message : String(err)}`,
      fix: "Start Docker: sudo systemctl start docker (or install: https://docs.docker.com/get-docker/)",
    };
  }
}

const IMAGE_DOCKERFILE_MAP: Record<string, string> = {
  "forgectl/code-node20": "Dockerfile.code-node20",
  "forgectl/research-browser": "Dockerfile.research-browser",
  "forgectl/content": "Dockerfile.content",
  "forgectl/data": "Dockerfile.data",
  "forgectl/ops": "Dockerfile.ops",
};

export async function checkDockerImages(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  try {
    const Docker = (await import("dockerode")).default;
    const docker = new Docker();
    // Verify Docker is reachable first
    await docker.version();

    const { listWorkflows } = await import("../workflow/registry.js");
    let workflows;
    try {
      workflows = listWorkflows();
    } catch {
      workflows = [];
    }

    const images = new Set<string>();
    for (const wf of workflows) {
      if (wf.sandbox?.image) {
        images.add(wf.sandbox.image);
      }
    }
    // Always check the default image
    images.add("forgectl/code-node20");

    for (const image of images) {
      try {
        await docker.getImage(image).inspect();
        results.push({ status: "pass", message: `Docker image: ${image}` });
      } catch {
        const dockerfile = IMAGE_DOCKERFILE_MAP[image];
        const fix = dockerfile
          ? `Build it: docker build -t ${image} -f dockerfiles/${dockerfile} dockerfiles/`
          : `Pull or build the image: docker pull ${image}`;
        results.push({
          status: "warn",
          message: `Docker image missing: ${image}`,
          fix,
        });
      }
    }
  } catch {
    // Docker not reachable — skip image checks (checkDocker already reports this)
  }
  return results;
}

export async function checkCredentialBackend(): Promise<CheckResult> {
  try {
    const { getStorageBackend } = await import("../auth/store.js");
    const backend = await getStorageBackend();
    if (backend === "keychain") {
      return { status: "pass", message: "Credential storage: OS keychain" };
    }
    return {
      status: "pass",
      message: "Credential storage: file fallback (~/.forgectl/credentials.json)",
    };
  } catch (err) {
    return {
      status: "warn",
      message: `Could not determine credential backend: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function checkCredentials(): Promise<CheckResult> {
  try {
    const { listCredentials, getStorageBackend } = await import("../auth/store.js");
    const creds = await listCredentials();
    const backend = await getStorageBackend();
    const backendLabel = backend === "keychain"
      ? "OS keychain"
      : "file (~/.forgectl/credentials.json)";
    if (creds.length === 0) {
      return {
        status: "warn",
        message: `No agent credentials configured (storage: ${backendLabel})`,
        fix: "Add credentials with: forgectl auth add claude-code",
      };
    }
    const providers = [...new Set(creds.map(c => c.provider))];
    return { status: "pass", message: `Credentials configured for: ${providers.join(", ")} (storage: ${backendLabel})` };
  } catch (err) {
    return {
      status: "warn",
      message: `Could not read credentials: ${err instanceof Error ? err.message : String(err)}`,
      fix: "Add credentials with: forgectl auth add claude-code",
    };
  }
}

export async function checkSqlite(): Promise<CheckResult> {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const dbPath = join(home, ".forgectl", "forgectl.db");

  if (!existsSync(dbPath)) {
    return {
      status: "warn",
      message: "SQLite database not found (will be created on first run)",
      fix: `Expected at: ${dbPath}`,
    };
  }

  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath, { readonly: true });
    const journalMode = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    const isWal = journalMode[0]?.journal_mode === "wal";
    db.close();

    if (!isWal) {
      return {
        status: "warn",
        message: "SQLite database exists but WAL mode is not enabled",
        fix: "Start the daemon to re-initialize: forgectl up",
      };
    }

    return { status: "pass", message: "SQLite database exists with WAL mode" };
  } catch (err) {
    return {
      status: "fail",
      message: `SQLite database error: ${err instanceof Error ? err.message : String(err)}`,
      fix: "Remove and recreate the database: rm ~/.forgectl/forgectl.db && forgectl up",
    };
  }
}

export async function checkDaemon(): Promise<CheckResult> {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const pidFile = join(home, ".forgectl", "daemon.pid");

  if (!existsSync(pidFile)) {
    return { status: "warn", message: "Daemon is not running (no PID file)", fix: "Start with: forgectl up" };
  }

  const raw = readFileSync(pidFile, "utf-8").trim();
  const pid = parseInt(raw, 10);
  if (isNaN(pid)) {
    return {
      status: "fail",
      message: "Daemon PID file contains invalid data",
      fix: `Remove stale PID file: rm ${pidFile}`,
    };
  }

  try {
    process.kill(pid, 0);
    return { status: "pass", message: `Daemon running (PID ${pid})` };
  } catch {
    return {
      status: "warn",
      message: `Daemon PID file exists but process ${pid} is not running (stale)`,
      fix: `Remove stale PID file: rm ${pidFile}`,
    };
  }
}

export async function checkGitHubApp(): Promise<CheckResult> {
  try {
    const { findConfigFile } = await import("../config/loader.js");
    const configPath = findConfigFile();
    if (!configPath) {
      return { status: "pass", message: "GitHub App: not configured (skipped)" };
    }

    const yaml = (await import("js-yaml")).default;
    const raw = readFileSync(configPath, "utf-8");
    const parsed = yaml.load(raw) as Record<string, unknown> | null;

    if (!parsed || !parsed.github_app) {
      return { status: "pass", message: "GitHub App: not configured (skipped)" };
    }

    const appConfig = parsed.github_app as Record<string, unknown>;
    const issues: string[] = [];

    if (!appConfig.app_id) {
      issues.push("app_id is missing");
    }

    if (!appConfig.private_key_path) {
      issues.push("private_key_path is missing");
    } else if (!existsSync(String(appConfig.private_key_path))) {
      issues.push(`private key file not found: ${appConfig.private_key_path}`);
    }

    if (!appConfig.webhook_secret) {
      issues.push("webhook_secret is missing");
    }

    if (issues.length > 0) {
      return {
        status: "fail",
        message: `GitHub App misconfigured: ${issues.join("; ")}`,
        fix: "Check github_app section in your forgectl config",
      };
    }

    return { status: "pass", message: "GitHub App configured correctly" };
  } catch (err) {
    return {
      status: "warn",
      message: `Could not check GitHub App config: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function checkMergerApp(): Promise<CheckResult> {
  try {
    const { findConfigFile } = await import("../config/loader.js");
    const configPath = findConfigFile();
    if (!configPath) {
      return { status: "pass", message: "Merger App: no config file (skipped)" };
    }

    const yaml = (await import("js-yaml")).default;
    const raw = readFileSync(configPath, "utf-8");
    const parsed = yaml.load(raw) as Record<string, unknown> | null;

    if (!parsed || !parsed.github_app) {
      return { status: "pass", message: "Merger App: github_app not configured (skipped)" };
    }

    if (!parsed.merger_app) {
      return {
        status: "warn",
        message: "github_app is configured but merger_app is missing — PR creation will fail if the creator app lacks pulls:write permission",
        fix: "Add merger_app (with pulls:write) to your forgectl config, or grant pulls:write to your github_app",
      };
    }

    return { status: "pass", message: "Merger App configured (PR creation will use merger app)" };
  } catch (err) {
    return {
      status: "warn",
      message: `Could not check merger_app config: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function checkConfig(): Promise<CheckResult> {
  try {
    const { findConfigFile, loadConfig } = await import("../config/loader.js");
    const configPath = findConfigFile();
    if (!configPath) {
      return { status: "warn", message: "No forgectl config file found", fix: "Create one with: forgectl init" };
    }

    loadConfig();
    return { status: "pass", message: `Config valid: ${configPath}` };
  } catch (err) {
    return {
      status: "fail",
      message: `Config validation failed: ${err instanceof Error ? err.message : String(err)}`,
      fix: "Fix your forgectl.yaml or regenerate with: forgectl init",
    };
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check the health of your forgectl setup")
    .action(async () => {
      console.log();
      console.log(chalk.bold("forgectl doctor"));
      console.log();

      const checks: Array<{ name: string; fn: () => Promise<CheckResult> }> = [
        { name: "Node.js", fn: checkNodeVersion },
        { name: "Docker", fn: checkDocker },
        { name: "Credentials", fn: checkCredentials },
        { name: "Credential Backend", fn: checkCredentialBackend },
        { name: "SQLite", fn: checkSqlite },
        { name: "Daemon", fn: checkDaemon },
        { name: "GitHub App", fn: checkGitHubApp },
        { name: "Merger App", fn: checkMergerApp },
        { name: "Config", fn: checkConfig },
      ];

      let failures = 0;
      let warnings = 0;

      for (const check of checks) {
        const result = await check.fn();
        console.log(formatResult(result));
        if (result.status === "fail") failures++;
        if (result.status === "warn") warnings++;
      }

      // Docker image checks (returns multiple results)
      const imageResults = await checkDockerImages();
      for (const result of imageResults) {
        console.log(formatResult(result));
        if (result.status === "fail") failures++;
        if (result.status === "warn") warnings++;
      }

      console.log();
      if (failures > 0) {
        console.log(chalk.red(`${failures} issue(s) found. Fix the above errors to use forgectl.`));
      } else if (warnings > 0) {
        console.log(chalk.yellow(`${warnings} warning(s). forgectl should work but some features may be unavailable.`));
      } else {
        console.log(chalk.green("All checks passed. forgectl is ready to use."));
      }
      console.log();
    });
}
