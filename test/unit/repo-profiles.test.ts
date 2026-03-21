import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { loadRepoProfile, loadConfigWithOptions, listRepoProfiles, deepMerge, loadConfig } from "../../src/config/loader.js";

const TEST_HOME = join(process.cwd(), "test-tmp-repo-profiles");

describe("repo profiles", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_HOME, ".forgectl", "repos"), { recursive: true });
    vi.stubEnv("HOME", TEST_HOME);
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  describe("loadRepoProfile", () => {
    it("merges overlay onto base config", () => {
      // Write base config
      writeFileSync(
        join(TEST_HOME, ".forgectl", "config.yaml"),
        yaml.dump({
          agent: { type: "claude-code", model: "sonnet" },
          tracker: { kind: "github", repo: "base/repo", token: "$GH_TOKEN" },
        }),
      );

      // Write overlay
      writeFileSync(
        join(TEST_HOME, ".forgectl", "repos", "myrepo.yaml"),
        yaml.dump({
          tracker: { kind: "github", repo: "owner/myrepo", token: "$gh" },
        }),
      );

      const config = loadRepoProfile("myrepo");
      expect(config.tracker?.repo).toBe("owner/myrepo");
      expect(config.tracker?.token).toBe("$gh");
      expect(config.agent.model).toBe("sonnet");
    });

    it("throws if profile does not exist", () => {
      expect(() => loadRepoProfile("nonexistent")).toThrow("Repo profile not found");
    });

    it("works without base config", () => {
      writeFileSync(
        join(TEST_HOME, ".forgectl", "repos", "standalone.yaml"),
        yaml.dump({
          tracker: { kind: "github", repo: "org/standalone", token: "$gh" },
        }),
      );

      const config = loadRepoProfile("standalone");
      expect(config.tracker?.repo).toBe("org/standalone");
      // Should have defaults for other fields
      expect(config.agent.type).toBe("claude-code");
    });
  });

  describe("loadConfigWithOptions", () => {
    it("throws if both config and repo are specified", () => {
      expect(() => loadConfigWithOptions({ config: "/path", repo: "name" })).toThrow("mutually exclusive");
    });

    it("loads by repo name", () => {
      writeFileSync(
        join(TEST_HOME, ".forgectl", "repos", "test.yaml"),
        yaml.dump({
          tracker: { kind: "github", repo: "org/test", token: "$gh" },
        }),
      );

      const config = loadConfigWithOptions({ repo: "test" });
      expect(config.tracker?.repo).toBe("org/test");
    });

    it("loads by explicit config path", () => {
      const configPath = join(TEST_HOME, "custom-config.yaml");
      writeFileSync(
        configPath,
        yaml.dump({
          agent: { type: "codex" },
        }),
      );

      const config = loadConfigWithOptions({ config: configPath });
      expect(config.agent.type).toBe("codex");
    });
  });

  describe("listRepoProfiles", () => {
    it("returns empty array if repos dir does not exist", () => {
      rmSync(join(TEST_HOME, ".forgectl", "repos"), { recursive: true, force: true });
      const profiles = listRepoProfiles();
      expect(profiles).toEqual([]);
    });

    it("lists profiles with tracker info", () => {
      writeFileSync(
        join(TEST_HOME, ".forgectl", "repos", "foo.yaml"),
        yaml.dump({ tracker: { kind: "github", repo: "org/foo", token: "$gh" } }),
      );
      writeFileSync(
        join(TEST_HOME, ".forgectl", "repos", "bar.yaml"),
        yaml.dump({ tracker: { kind: "github", repo: "org/bar", token: "$gh" } }),
      );

      const profiles = listRepoProfiles();
      expect(profiles).toHaveLength(2);
      expect(profiles.map(p => p.name).sort()).toEqual(["bar", "foo"]);
      expect(profiles.find(p => p.name === "foo")?.trackerRepo).toBe("org/foo");
    });
  });

  describe("loadConfig with repo: sentinel", () => {
    it("loads repo profile via sentinel prefix", () => {
      writeFileSync(
        join(TEST_HOME, ".forgectl", "repos", "sentinel.yaml"),
        yaml.dump({ tracker: { kind: "github", repo: "org/sentinel", token: "$gh" } }),
      );

      const profilePath = join(TEST_HOME, ".forgectl", "repos", "sentinel.yaml");
      const config = loadConfig(`repo:${profilePath}`);
      expect(config.tracker?.repo).toBe("org/sentinel");
    });
  });
});
