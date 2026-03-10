import { describe, it, expect, vi } from "vitest";
import { hasWriteAccess } from "../../src/github/permissions.js";

function createMockOctokit(permission: string, shouldThrow = false) {
  return {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: shouldThrow
          ? vi.fn().mockRejectedValue(new Error("Not Found"))
          : vi.fn().mockResolvedValue({
              data: { permission },
            }),
      },
    },
  } as any;
}

describe("hasWriteAccess", () => {
  it('returns true for "admin" permission', async () => {
    const octokit = createMockOctokit("admin");
    expect(await hasWriteAccess(octokit, "owner", "repo", "user")).toBe(true);
  });

  it('returns true for "write" permission', async () => {
    const octokit = createMockOctokit("write");
    expect(await hasWriteAccess(octokit, "owner", "repo", "user")).toBe(true);
  });

  it('returns false for "read" permission', async () => {
    const octokit = createMockOctokit("read");
    expect(await hasWriteAccess(octokit, "owner", "repo", "user")).toBe(false);
  });

  it('returns false for "none" permission', async () => {
    const octokit = createMockOctokit("none");
    expect(await hasWriteAccess(octokit, "owner", "repo", "user")).toBe(false);
  });

  it("returns false when API throws (non-collaborator)", async () => {
    const octokit = createMockOctokit("", true);
    expect(await hasWriteAccess(octokit, "owner", "repo", "user")).toBe(false);
  });
});
