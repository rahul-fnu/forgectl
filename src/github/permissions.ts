import type { Octokit } from "@octokit/core";

/**
 * Check if a user has write or admin access to a repository.
 * Returns false on any error (e.g., user is not a collaborator).
 */
export async function hasWriteAccess(
  octokit: Octokit,
  owner: string,
  repo: string,
  username: string,
): Promise<boolean> {
  try {
    const response = await (octokit as any).rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });
    const permission: string = response.data.permission;
    return permission === "admin" || permission === "write";
  } catch {
    return false;
  }
}
