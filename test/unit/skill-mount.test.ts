import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:fs and node:os before importing the module under test
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(),
}));

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import {
  prepareSkillMounts,
  validateNoCredentials,
  CREDENTIAL_DENY_LIST,
} from "../../src/skills/mount.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockHomedir = vi.mocked(homedir);

beforeEach(() => {
  vi.resetAllMocks();
  mockHomedir.mockReturnValue("/home/testuser");
  // Default: nothing exists
  mockExistsSync.mockReturnValue(false);
  mockReaddirSync.mockReturnValue([]);
});

describe("CREDENTIAL_DENY_LIST", () => {
  it("is a Set containing known credential file names", () => {
    expect(CREDENTIAL_DENY_LIST).toBeInstanceOf(Set);
    expect(CREDENTIAL_DENY_LIST.has(".credentials.json")).toBe(true);
    expect(CREDENTIAL_DENY_LIST.has("credentials.json")).toBe(true);
    expect(CREDENTIAL_DENY_LIST.has("auth.json")).toBe(true);
    expect(CREDENTIAL_DENY_LIST.has("statsig")).toBe(true);
    expect(CREDENTIAL_DENY_LIST.has(".env")).toBe(true);
    expect(CREDENTIAL_DENY_LIST.has("token")).toBe(true);
    expect(CREDENTIAL_DENY_LIST.has("api_key")).toBe(true);
  });
});

describe("validateNoCredentials", () => {
  it("does not throw for a clean directory", () => {
    mockReaddirSync.mockReturnValue(["index.ts", "utils.ts", "README.md"] as unknown as ReturnType<typeof readdirSync>);
    expect(() => validateNoCredentials("/some/clean/dir")).not.toThrow();
  });

  it("throws when directory contains .credentials.json", () => {
    mockReaddirSync.mockReturnValue([".credentials.json"] as unknown as ReturnType<typeof readdirSync>);
    expect(() => validateNoCredentials("/some/dir")).toThrow(/security violation/i);
  });

  it("throws when directory contains statsig (a directory name in deny list)", () => {
    mockReaddirSync.mockReturnValue(["statsig"] as unknown as ReturnType<typeof readdirSync>);
    expect(() => validateNoCredentials("/some/dir")).toThrow(/security violation/i);
  });

  it("throws when nested path contains .credentials.json (recursive check)", () => {
    // readdirSync with recursive returns full relative paths
    mockReaddirSync.mockReturnValue(["subdir/.credentials.json"] as unknown as ReturnType<typeof readdirSync>);
    expect(() => validateNoCredentials("/some/dir")).toThrow(/security violation/i);
  });

  it("throws with descriptive message including file and path", () => {
    mockReaddirSync.mockReturnValue([".credentials.json"] as unknown as ReturnType<typeof readdirSync>);
    expect(() => validateNoCredentials("/home/user/.claude/skills/my-skill")).toThrow(
      /credential file.*credentials\.json.*found in.*my-skill/i,
    );
  });

  it("does not throw when deep paths have benign names that contain deny-list words as substring", () => {
    // 'my_token_helper.ts' contains 'token' as substring but basename is 'my_token_helper.ts', not 'token'
    mockReaddirSync.mockReturnValue(["my_token_helper.ts"] as unknown as ReturnType<typeof readdirSync>);
    expect(() => validateNoCredentials("/some/dir")).not.toThrow();
  });
});

describe("prepareSkillMounts", () => {
  it("returns empty mounts when noSkills is true", () => {
    const result = prepareSkillMounts(["code-review"], true);
    expect(result.mounts.binds).toEqual([]);
    expect(result.addDirFlags).toEqual([]);
  });

  it("returns empty mounts when skills array is empty", () => {
    const result = prepareSkillMounts([], false);
    expect(result.mounts.binds).toEqual([]);
    expect(result.addDirFlags).toEqual([]);
  });

  it("mounts skill from ~/.claude/skills/ when that directory exists", () => {
    const skillsPath = "/home/testuser/.claude/skills/code-review";
    mockExistsSync.mockImplementation((p) => p === skillsPath);
    mockReaddirSync.mockReturnValue([]);

    const result = prepareSkillMounts(["code-review"], false);

    expect(result.mounts.binds).toContain(
      `${skillsPath}:/home/node/.claude/skills/code-review:ro`,
    );
    expect(result.addDirFlags).toContain("--add-dir");
    expect(result.addDirFlags).toContain("/home/node/.claude/skills/code-review");
  });

  it("--add-dir flags are separate array entries (not joined)", () => {
    const skillsPath = "/home/testuser/.claude/skills/code-review";
    mockExistsSync.mockImplementation((p) => p === skillsPath);
    mockReaddirSync.mockReturnValue([]);

    const result = prepareSkillMounts(["code-review"], false);

    // Each --add-dir and its value must be separate entries
    const flagIdx = result.addDirFlags.indexOf("--add-dir");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(result.addDirFlags[flagIdx + 1]).toBe("/home/node/.claude/skills/code-review");
    // No entry should be "--add-dir /path" as a single string
    expect(result.addDirFlags.some((f) => f.startsWith("--add-dir /"))).toBe(false);
  });

  it("mounts skill from ~/.claude/agents/ when that directory exists (no skills/ match)", () => {
    const agentsPath = "/home/testuser/.claude/agents/code-review";
    mockExistsSync.mockImplementation((p) => p === agentsPath);
    mockReaddirSync.mockReturnValue([]);

    const result = prepareSkillMounts(["code-review"], false);

    expect(result.mounts.binds).toContain(
      `${agentsPath}:/home/node/.claude/agents/code-review:ro`,
    );
    expect(result.addDirFlags).toContain("--add-dir");
    expect(result.addDirFlags).toContain("/home/node/.claude/agents/code-review");
  });

  it("mounts from both skills/ and agents/ when both directories exist", () => {
    const skillsPath = "/home/testuser/.claude/skills/code-review";
    const agentsPath = "/home/testuser/.claude/agents/code-review";
    mockExistsSync.mockImplementation(
      (p) => p === skillsPath || p === agentsPath,
    );
    mockReaddirSync.mockReturnValue([]);

    const result = prepareSkillMounts(["code-review"], false);

    expect(result.mounts.binds).toContain(
      `${skillsPath}:/home/node/.claude/skills/code-review:ro`,
    );
    expect(result.mounts.binds).toContain(
      `${agentsPath}:/home/node/.claude/agents/code-review:ro`,
    );
    // Should have two --add-dir pairs
    const addDirCount = result.addDirFlags.filter((f) => f === "--add-dir").length;
    expect(addDirCount).toBe(2);
  });

  it("silently skips missing skill directories (no throw, empty result)", () => {
    // existsSync returns false for everything (default)
    expect(() => prepareSkillMounts(["nonexistent"], false)).not.toThrow();
    const result = prepareSkillMounts(["nonexistent"], false);
    expect(result.mounts.binds).toEqual([]);
    expect(result.addDirFlags).toEqual([]);
  });

  it("mounts ~/CLAUDE.md when it exists on host", () => {
    const claudeMdPath = "/home/testuser/CLAUDE.md";
    mockExistsSync.mockImplementation((p) => p === claudeMdPath);

    const result = prepareSkillMounts(["any-skill"], false);

    expect(result.mounts.binds).toContain(
      `${claudeMdPath}:/home/node/CLAUDE.md:ro`,
    );
  });

  it("does NOT mount ~/CLAUDE.md when noSkills is true", () => {
    const claudeMdPath = "/home/testuser/CLAUDE.md";
    mockExistsSync.mockImplementation((p) => p === claudeMdPath);

    const result = prepareSkillMounts(["any-skill"], true);

    expect(result.mounts.binds).not.toContain(
      `${claudeMdPath}:/home/node/CLAUDE.md:ro`,
    );
  });

  it("returns mounts object with empty env and no-op cleanup", () => {
    const result = prepareSkillMounts([], false);
    expect(result.mounts.env).toEqual({});
    expect(typeof result.mounts.cleanup).toBe("function");
    expect(() => result.mounts.cleanup()).not.toThrow();
  });

  it("throws security violation when skill dir contains credential files", () => {
    const skillsPath = "/home/testuser/.claude/skills/bad-skill";
    mockExistsSync.mockImplementation((p) => p === skillsPath);
    mockReaddirSync.mockReturnValue([".credentials.json"] as unknown as ReturnType<typeof readdirSync>);

    expect(() => prepareSkillMounts(["bad-skill"], false)).toThrow(
      /security violation/i,
    );
  });

  it("mounts multiple skills correctly", () => {
    const skill1 = "/home/testuser/.claude/skills/skill-a";
    const skill2 = "/home/testuser/.claude/skills/skill-b";
    mockExistsSync.mockImplementation((p) => p === skill1 || p === skill2);
    mockReaddirSync.mockReturnValue([]);

    const result = prepareSkillMounts(["skill-a", "skill-b"], false);

    expect(result.mounts.binds).toHaveLength(2);
    expect(result.mounts.binds).toContain(
      `${skill1}:/home/node/.claude/skills/skill-a:ro`,
    );
    expect(result.mounts.binds).toContain(
      `${skill2}:/home/node/.claude/skills/skill-b:ro`,
    );
    const addDirCount = result.addDirFlags.filter((f) => f === "--add-dir").length;
    expect(addDirCount).toBe(2);
  });
});
