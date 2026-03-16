import { describe, it, expect, vi, beforeEach } from "vitest";
import { ImageCache, type CacheKeyInputs } from "../../src/container/cache.js";

// Create a mock Docker instance factory
function createMockDocker(options?: {
  images?: Array<{
    Id: string;
    RepoTags: string[];
    Size: number;
    Created: number;
    Labels?: Record<string, string>;
  }>;
  inspectShouldFail?: boolean;
}) {
  const opts = options ?? {};
  const removeFn = vi.fn().mockResolvedValue(undefined);
  const tagFn = vi.fn().mockResolvedValue(undefined);

  const mockDocker = {
    getImage: vi.fn().mockReturnValue({
      inspect: opts.inspectShouldFail
        ? vi.fn().mockRejectedValue(new Error("not found"))
        : vi.fn().mockResolvedValue({}),
      tag: tagFn,
      remove: removeFn,
    }),
    listImages: vi.fn().mockResolvedValue(opts.images ?? []),
    _removeFn: removeFn,
    _tagFn: tagFn,
  };

  return mockDocker;
}

describe("ImageCache", () => {
  describe("getCacheKey", () => {
    it("returns a deterministic 12-char hex hash", () => {
      const cache = new ImageCache(createMockDocker() as never);
      const inputs: CacheKeyInputs = {
        baseImage: "node:20",
        tools: ["git", "npm"],
        networkMode: "open",
      };
      const key = cache.getCacheKey(inputs);
      expect(key).toHaveLength(12);
      expect(key).toMatch(/^[a-f0-9]{12}$/);
      // Same inputs produce same key
      expect(cache.getCacheKey(inputs)).toBe(key);
    });

    it("produces different keys for different base images", () => {
      const cache = new ImageCache(createMockDocker() as never);
      const base: CacheKeyInputs = {
        baseImage: "node:20",
        tools: ["git"],
        networkMode: "open",
      };
      const key1 = cache.getCacheKey(base);
      const key2 = cache.getCacheKey({ ...base, baseImage: "python:3.12" });
      expect(key1).not.toBe(key2);
    });

    it("produces different keys for different tools", () => {
      const cache = new ImageCache(createMockDocker() as never);
      const base: CacheKeyInputs = {
        baseImage: "node:20",
        tools: ["git"],
        networkMode: "open",
      };
      const key1 = cache.getCacheKey(base);
      const key2 = cache.getCacheKey({ ...base, tools: ["git", "ripgrep"] });
      expect(key1).not.toBe(key2);
    });

    it("produces different keys for different network modes", () => {
      const cache = new ImageCache(createMockDocker() as never);
      const base: CacheKeyInputs = {
        baseImage: "node:20",
        tools: [],
        networkMode: "open",
      };
      const key1 = cache.getCacheKey(base);
      const key2 = cache.getCacheKey({ ...base, networkMode: "airgapped" });
      expect(key1).not.toBe(key2);
    });

    it("produces different keys for different dockerfile instructions", () => {
      const cache = new ImageCache(createMockDocker() as never);
      const base: CacheKeyInputs = {
        baseImage: "node:20",
        dockerfileInstructions: "RUN npm install",
        tools: [],
        networkMode: "open",
      };
      const key1 = cache.getCacheKey(base);
      const key2 = cache.getCacheKey({
        ...base,
        dockerfileInstructions: "RUN pip install",
      });
      expect(key1).not.toBe(key2);
    });

    it("sorts tools for consistent hashing regardless of order", () => {
      const cache = new ImageCache(createMockDocker() as never);
      const key1 = cache.getCacheKey({
        baseImage: "node:20",
        tools: ["git", "npm", "ripgrep"],
        networkMode: "open",
      });
      const key2 = cache.getCacheKey({
        baseImage: "node:20",
        tools: ["ripgrep", "git", "npm"],
        networkMode: "open",
      });
      expect(key1).toBe(key2);
    });
  });

  describe("getCacheTag", () => {
    it("returns the full image tag", () => {
      const cache = new ImageCache(createMockDocker() as never);
      expect(cache.getCacheTag("abc123def456")).toBe("forgectl-cache:abc123def456");
    });
  });

  describe("hasCache", () => {
    it("returns true when cached image exists", async () => {
      const mockDocker = createMockDocker({ inspectShouldFail: false });
      const cache = new ImageCache(mockDocker as never);

      const result = await cache.hasCache("abc123");
      expect(result).toBe(true);
      expect(mockDocker.getImage).toHaveBeenCalledWith("forgectl-cache:abc123");
    });

    it("returns false when cached image does not exist", async () => {
      const mockDocker = createMockDocker({ inspectShouldFail: true });
      const cache = new ImageCache(mockDocker as never);

      const result = await cache.hasCache("missing");
      expect(result).toBe(false);
    });
  });

  describe("tagCache", () => {
    it("tags the source image with cache repo and key", async () => {
      const mockDocker = createMockDocker();
      const cache = new ImageCache(mockDocker as never);

      await cache.tagCache("forgectl-custom:latest", "abc123");
      expect(mockDocker.getImage).toHaveBeenCalledWith("forgectl-custom:latest");
      expect(mockDocker._tagFn).toHaveBeenCalledWith({
        repo: "forgectl-cache",
        tag: "abc123",
      });
    });
  });

  describe("listCached", () => {
    it("returns empty array when no cached images", async () => {
      const mockDocker = createMockDocker({ images: [] });
      const cache = new ImageCache(mockDocker as never);

      const result = await cache.listCached();
      expect(result).toEqual([]);
    });

    it("returns cached images sorted by creation time descending", async () => {
      const now = Date.now();
      const mockDocker = createMockDocker({
        images: [
          {
            Id: "sha256:aaa",
            RepoTags: ["forgectl-cache:older"],
            Size: 100 * 1024 * 1024,
            Created: (now - 86400000) / 1000,
            Labels: { "forgectl.workflow": "code" },
          },
          {
            Id: "sha256:bbb",
            RepoTags: ["forgectl-cache:newer"],
            Size: 200 * 1024 * 1024,
            Created: now / 1000,
            Labels: { "forgectl.workflow": "research" },
          },
        ],
      });
      const cache = new ImageCache(mockDocker as never);

      const result = await cache.listCached();
      expect(result).toHaveLength(2);
      expect(result[0].tag).toBe("newer");
      expect(result[0].workflowName).toBe("research");
      expect(result[1].tag).toBe("older");
      expect(result[1].workflowName).toBe("code");
    });

    it("handles images with no labels", async () => {
      const mockDocker = createMockDocker({
        images: [
          {
            Id: "sha256:ccc",
            RepoTags: ["forgectl-cache:abc123"],
            Size: 50 * 1024 * 1024,
            Created: Date.now() / 1000,
          },
        ],
      });
      const cache = new ImageCache(mockDocker as never);

      const result = await cache.listCached();
      expect(result).toHaveLength(1);
      expect(result[0].workflowName).toBe("unknown");
    });
  });

  describe("pruneCache", () => {
    let mockDocker: ReturnType<typeof createMockDocker>;
    let cache: ImageCache;
    const now = Date.now();

    beforeEach(() => {
      mockDocker = createMockDocker({
        images: [
          {
            Id: "sha256:aaa",
            RepoTags: ["forgectl-cache:old1"],
            Size: 100 * 1024 * 1024,
            Created: (now - 10 * 86400000) / 1000, // 10 days old
            Labels: { "forgectl.workflow": "code" },
          },
          {
            Id: "sha256:bbb",
            RepoTags: ["forgectl-cache:new1"],
            Size: 200 * 1024 * 1024,
            Created: (now - 3600000) / 1000, // 1 hour old
            Labels: { "forgectl.workflow": "code" },
          },
          {
            Id: "sha256:ccc",
            RepoTags: ["forgectl-cache:old2"],
            Size: 150 * 1024 * 1024,
            Created: (now - 8 * 86400000) / 1000, // 8 days old
            Labels: { "forgectl.workflow": "research" },
          },
        ],
      });
      cache = new ImageCache(mockDocker as never);
    });

    it("removes all cached images when no filters", async () => {
      const removed = await cache.pruneCache();
      expect(removed).toBe(3);
    });

    it("filters by workflow name", async () => {
      const removed = await cache.pruneCache({ workflowName: "code" });
      expect(removed).toBe(2);
    });

    it("filters by age with olderThan", async () => {
      const removed = await cache.pruneCache({ olderThan: "7d" });
      expect(removed).toBe(2); // 10-day and 8-day images
    });

    it("combines workflow name and age filters", async () => {
      const removed = await cache.pruneCache({
        workflowName: "code",
        olderThan: "7d",
      });
      expect(removed).toBe(1); // only the 10-day-old code image
    });

    it("returns 0 when no images match", async () => {
      const removed = await cache.pruneCache({ workflowName: "nonexistent" });
      expect(removed).toBe(0);
    });

    it("handles remove failures gracefully", async () => {
      mockDocker.getImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({}),
        tag: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockRejectedValue(new Error("conflict")),
      });

      const removed = await cache.pruneCache();
      expect(removed).toBe(0); // All removes failed
    });
  });
});
