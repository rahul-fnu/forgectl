import Docker from "dockerode";
import { hashString } from "../utils/hash.js";
import { parseDuration } from "../utils/duration.js";

const CACHE_REPO = "forgectl-cache";

export interface CachedImageInfo {
  id: string;
  tag: string;
  workflowName: string;
  size: number;
  createdAt: Date;
}

export interface CacheKeyInputs {
  baseImage: string;
  dockerfileInstructions?: string;
  tools: string[];
  networkMode: string;
}

/**
 * Manages Docker image caching for workflow containers.
 * Uses content-addressable tags under the `forgectl-cache` repository.
 */
export class ImageCache {
  private docker: Docker;

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker();
  }

  /**
   * Compute a deterministic cache key from the inputs that affect the image.
   */
  getCacheKey(inputs: CacheKeyInputs): string {
    const parts = [
      `image:${inputs.baseImage}`,
      `dockerfile:${inputs.dockerfileInstructions ?? ""}`,
      `tools:${[...inputs.tools].sort().join(",")}`,
      `network:${inputs.networkMode}`,
    ];
    return hashString(parts.join("|"));
  }

  /**
   * Get the full image tag for a cache key.
   */
  getCacheTag(cacheKey: string): string {
    return `${CACHE_REPO}:${cacheKey}`;
  }

  /**
   * Check if a cached image exists for the given cache key.
   */
  async hasCache(cacheKey: string): Promise<boolean> {
    const tag = this.getCacheTag(cacheKey);
    try {
      await this.docker.getImage(tag).inspect();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Tag a built image for caching.
   */
  async tagCache(sourceImage: string, cacheKey: string): Promise<void> {
    const image = this.docker.getImage(sourceImage);
    await image.tag({ repo: CACHE_REPO, tag: cacheKey });
  }

  /**
   * List all cached images with metadata.
   */
  async listCached(): Promise<CachedImageInfo[]> {
    const images = await this.docker.listImages({
      filters: { reference: [CACHE_REPO] },
    });

    const result: CachedImageInfo[] = [];
    for (const img of images) {
      const tags = img.RepoTags ?? [];
      for (const tag of tags) {
        if (!tag.startsWith(`${CACHE_REPO}:`)) continue;
        const cacheTag = tag.split(":")[1];
        const labels = img.Labels ?? {};
        result.push({
          id: img.Id,
          tag: cacheTag,
          workflowName: labels["forgectl.workflow"] ?? "unknown",
          size: img.Size,
          createdAt: new Date(img.Created * 1000),
        });
      }
    }

    return result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Remove cached images, optionally filtered by workflow name and/or age.
   */
  async pruneCache(options?: {
    workflowName?: string;
    olderThan?: string;
  }): Promise<number> {
    const cached = await this.listCached();
    const now = Date.now();
    let maxAgeMs: number | undefined;

    if (options?.olderThan) {
      maxAgeMs = parseDuration(options.olderThan);
    }

    let removed = 0;
    for (const entry of cached) {
      if (options?.workflowName && entry.workflowName !== options.workflowName) {
        continue;
      }
      if (maxAgeMs !== undefined) {
        const ageMs = now - entry.createdAt.getTime();
        if (ageMs < maxAgeMs) continue;
      }
      try {
        await this.docker.getImage(`${CACHE_REPO}:${entry.tag}`).remove({ force: true });
        removed++;
      } catch {
        // Image may have been removed concurrently; skip
      }
    }

    return removed;
  }
}
