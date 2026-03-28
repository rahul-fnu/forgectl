import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkGitHubAppAccess, autoGenerateProfile } from "../../src/config/auto-profile.js";
import { Logger } from "../../src/logging/logger.js";

const TEST_HOME = join(process.cwd(), "test-tmp-auto-profile");

describe("auto-profile", () => {
  let logger: Logger;

  beforeEach(() => {
    mkdirSync(join(TEST_HOME, ".forgectl", "repos"), { recursive: true });
    vi.stubEnv("HOME", TEST_HOME);
    logger = new Logger(false);
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("checkGitHubAppAccess", () => {
    it("returns true when app is installed (200)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
      const result = await checkGitHubAppAccess("owner", "repo", "tok", logger);
      expect(result).toBe(true);
    });

    it("returns false when app is not installed (404)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
      const result = await checkGitHubAppAccess("owner", "repo", "tok", logger);
      expect(result).toBe(false);
    });

    it("returns false on network error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
      const result = await checkGitHubAppAccess("owner", "repo", "tok", logger);
      expect(result).toBe(false);
    });

    it("returns false on unexpected status code", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
      const result = await checkGitHubAppAccess("owner", "repo", "tok", logger);
      expect(result).toBe(false);
    });
  });

  describe("autoGenerateProfile", () => {
    it("generates profile and reports app installed", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
      const result = await autoGenerateProfile("owner/myrepo", "tok", logger);
      expect(result.appInstalled).toBe(true);
      expect(result.repoSlug).toBe("owner/myrepo");
      const profilePath = join(TEST_HOME, ".forgectl", "repos", "myrepo.yaml");
      expect(existsSync(profilePath)).toBe(true);
      const content = readFileSync(profilePath, "utf-8");
      expect(content).toContain("owner/myrepo");
    });

    it("posts comment when app not installed and tracker provided", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
      const tracker = { postComment: vi.fn().mockResolvedValue(undefined) } as any;
      const result = await autoGenerateProfile("owner/myrepo", "tok", logger, {
        tracker,
        issueId: "42",
        appName: "my-app",
      });
      expect(result.appInstalled).toBe(false);
      expect(tracker.postComment).toHaveBeenCalledWith(
        "42",
        expect.stringContaining("https://github.com/apps/my-app/installations/new"),
      );
    });

    it("does not overwrite existing profile", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
      const profilePath = join(TEST_HOME, ".forgectl", "repos", "myrepo.yaml");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(profilePath, "existing: true\n", "utf-8");
      await autoGenerateProfile("owner/myrepo", "tok", logger);
      const content = readFileSync(profilePath, "utf-8");
      expect(content).toBe("existing: true\n");
    });
  });
});
