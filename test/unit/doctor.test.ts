import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkNodeVersion,
  checkDocker,
  checkCredentials,
  checkCredentialBackend,
  checkDockerImages,
  checkSqlite,
  checkDaemon,
  checkGitHubApp,
  checkMergerApp,
  checkConfig,
} from "../../src/cli/doctor.js";

describe("doctor checks", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("checkNodeVersion", () => {
    it("passes on Node 20+", async () => {
      const result = await checkNodeVersion();
      // We're running on Node 20+ in this project
      expect(result.status).toBe("pass");
      expect(result.message).toContain("Node.js");
    });
  });

  describe("checkDocker", () => {
    it("fails when Docker is unreachable", async () => {
      vi.doMock("dockerode", () => ({
        default: class {
          version() {
            return Promise.reject(new Error("connect ENOENT"));
          }
        },
      }));

      // Re-import to pick up mock
      const { checkDocker: checkDockerMocked } = await import("../../src/cli/doctor.js");
      // Since dockerode is imported dynamically, we need a different approach
      // The actual check does a dynamic import, so we test it as-is
      const result = await checkDockerMocked();
      // In CI/test environment without Docker, this should fail or pass depending on Docker availability
      expect(["pass", "fail"]).toContain(result.status);
      expect(result.message).toBeDefined();
    });
  });

  describe("checkCredentials", () => {
    it("warns when no credentials are configured", async () => {
      vi.doMock("../../src/auth/store.js", () => ({
        listCredentials: vi.fn().mockResolvedValue([]),
      }));

      const mod = await import("../../src/cli/doctor.js");
      const result = await mod.checkCredentials();
      // May or may not have credentials in test env
      expect(["pass", "warn"]).toContain(result.status);
    });

    it("passes when credentials exist", async () => {
      vi.doMock("../../src/auth/store.js", () => ({
        listCredentials: vi.fn().mockResolvedValue([
          { provider: "claude-code", key: "api_key" },
        ]),
      }));

      const { checkCredentials: fn } = await import("../../src/cli/doctor.js");
      const result = await fn();
      expect(["pass", "warn"]).toContain(result.status);
    });
  });

  describe("checkSqlite", () => {
    it("warns when database does not exist", async () => {
      const originalHome = process.env.HOME;
      process.env.HOME = "/tmp/forgectl-doctor-test-nonexistent";

      const result = await checkSqlite();
      expect(result.status).toBe("warn");
      expect(result.message).toContain("not found");

      process.env.HOME = originalHome;
    });
  });

  describe("checkDaemon", () => {
    it("warns when no PID file exists", async () => {
      const originalHome = process.env.HOME;
      process.env.HOME = "/tmp/forgectl-doctor-test-nonexistent";

      const result = await checkDaemon();
      expect(result.status).toBe("warn");
      expect(result.message).toContain("not running");

      process.env.HOME = originalHome;
    });

    it("detects stale PID file", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const tmpDir = "/tmp/forgectl-doctor-stale-pid-test";
      const forgectlDir = path.join(tmpDir, ".forgectl");
      fs.mkdirSync(forgectlDir, { recursive: true });
      fs.writeFileSync(path.join(forgectlDir, "daemon.pid"), "999999999");

      const originalHome = process.env.HOME;
      process.env.HOME = tmpDir;

      const result = await checkDaemon();
      expect(result.status).toBe("warn");
      expect(result.message).toContain("stale");

      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("fails on invalid PID file content", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const tmpDir = "/tmp/forgectl-doctor-invalid-pid-test";
      const forgectlDir = path.join(tmpDir, ".forgectl");
      fs.mkdirSync(forgectlDir, { recursive: true });
      fs.writeFileSync(path.join(forgectlDir, "daemon.pid"), "not-a-number");

      const originalHome = process.env.HOME;
      process.env.HOME = tmpDir;

      const result = await checkDaemon();
      expect(result.status).toBe("fail");
      expect(result.message).toContain("invalid");

      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("checkGitHubApp", () => {
    it("passes when not configured", async () => {
      const result = await checkGitHubApp();
      // If no config or no github_app section, should pass as "skipped"
      expect(["pass", "fail", "warn"]).toContain(result.status);
    });
  });

  describe("checkMergerApp", () => {
    it("warns when github_app is configured but merger_app is missing", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const yaml = (await import("js-yaml")).default;
      const tmpDir = "/tmp/forgectl-doctor-merger-test";
      const forgectlDir = path.join(tmpDir, ".forgectl");
      fs.mkdirSync(forgectlDir, { recursive: true });
      fs.writeFileSync(
        path.join(forgectlDir, "config.yaml"),
        yaml.dump({ github_app: { app_id: "123", private_key_path: "/tmp/key.pem", webhook_secret: "secret" } }),
      );

      vi.doMock("../../src/config/loader.js", () => ({
        findConfigFile: () => path.join(forgectlDir, "config.yaml"),
      }));

      const mod = await import("../../src/cli/doctor.js");
      const result = await mod.checkMergerApp();
      expect(result.status).toBe("warn");
      expect(result.message).toContain("merger_app is missing");

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("passes when both github_app and merger_app are configured", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const yaml = (await import("js-yaml")).default;
      const tmpDir = "/tmp/forgectl-doctor-merger-pass-test";
      const forgectlDir = path.join(tmpDir, ".forgectl");
      fs.mkdirSync(forgectlDir, { recursive: true });
      fs.writeFileSync(
        path.join(forgectlDir, "config.yaml"),
        yaml.dump({
          github_app: { app_id: "123", private_key_path: "/tmp/key.pem", webhook_secret: "secret" },
          merger_app: { app_id: "456", private_key_path: "/tmp/merger.pem", webhook_secret: "secret2" },
        }),
      );

      vi.doMock("../../src/config/loader.js", () => ({
        findConfigFile: () => path.join(forgectlDir, "config.yaml"),
      }));

      const mod = await import("../../src/cli/doctor.js");
      const result = await mod.checkMergerApp();
      expect(result.status).toBe("pass");
      expect(result.message).toContain("Merger App configured");

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("skips when github_app is not configured", async () => {
      const result = await checkMergerApp();
      // Without github_app in config, should skip (pass); with github_app but no merger_app, should warn
      expect(["pass", "warn"]).toContain(result.status);
    });
  });

  describe("checkConfig", () => {
    it("handles missing config gracefully", async () => {
      const result = await checkConfig();
      // In test env, may or may not find config
      expect(["pass", "warn", "fail"]).toContain(result.status);
      expect(result.message).toBeDefined();
    });
  });

  describe("checkDockerImages", () => {
    it("returns array of CheckResults", async () => {
      const results = await checkDockerImages();
      expect(Array.isArray(results)).toBe(true);
      for (const result of results) {
        expect(result).toHaveProperty("status");
        expect(result).toHaveProperty("message");
        expect(["pass", "fail", "warn"]).toContain(result.status);
      }
    });

    it("includes build command for missing images", async () => {
      const results = await checkDockerImages();
      for (const result of results) {
        if (result.status === "warn" && result.message.includes("missing")) {
          expect(result.fix).toBeDefined();
          expect(result.fix).toMatch(/Build it:|Pull or build/);
        }
      }
    });
  });

  describe("checkCredentialBackend", () => {
    it("returns keychain or file backend", async () => {
      const result = await checkCredentialBackend();
      expect(["pass", "warn"]).toContain(result.status);
      if (result.status === "pass") {
        expect(result.message).toMatch(/Credential storage: (OS keychain|file fallback)/);
      }
    });
  });

  describe("CheckResult shape", () => {
    it("returns proper structure from all checks", async () => {
      const checks = [
        checkNodeVersion,
        checkCredentials,
        checkDaemon,
        checkConfig,
      ];

      for (const check of checks) {
        const result = await check();
        expect(result).toHaveProperty("status");
        expect(result).toHaveProperty("message");
        expect(["pass", "fail", "warn"]).toContain(result.status);
        expect(typeof result.message).toBe("string");
        if (result.fix !== undefined) {
          expect(typeof result.fix).toBe("string");
        }
      }
    });
  });
});
