import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SubIssueCache, SubIssueEntry } from "../../src/tracker/sub-issue-cache.js";

function makeEntry(parentId: string, childIds: string[] = []): SubIssueEntry {
  const childStates = new Map<string, string>();
  for (const id of childIds) {
    childStates.set(id, "open");
  }
  return {
    parentId,
    childIds,
    childStates,
    fetchedAt: Date.now(),
  };
}

describe("SubIssueCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("get()", () => {
    it("returns null for unknown parentId", () => {
      const cache = new SubIssueCache();
      expect(cache.get("999")).toBeNull();
    });

    it("returns cached entry within TTL", () => {
      const cache = new SubIssueCache();
      const entry = makeEntry("42", ["10", "11"]);
      cache.set(entry);
      expect(cache.get("42")).toEqual(entry);
    });

    it("returns null and deletes entry after TTL expires", () => {
      const cache = new SubIssueCache(5000); // 5 second TTL
      const entry = makeEntry("42", ["10"]);
      cache.set(entry);

      // Advance time past TTL
      vi.advanceTimersByTime(5001);

      expect(cache.get("42")).toBeNull();
    });

    it("still returns entry just before TTL expires", () => {
      const cache = new SubIssueCache(5000);
      const entry = makeEntry("42", ["10"]);
      cache.set(entry);

      vi.advanceTimersByTime(4999);

      expect(cache.get("42")).toEqual(entry);
    });
  });

  describe("set()", () => {
    it("stores entry retrievable by parentId", () => {
      const cache = new SubIssueCache();
      const entry = makeEntry("100", ["200", "300"]);
      cache.set(entry);
      expect(cache.get("100")).toEqual(entry);
    });

    it("overwrites existing entry for same parentId", () => {
      const cache = new SubIssueCache();
      const entry1 = makeEntry("42", ["10"]);
      const entry2 = makeEntry("42", ["10", "11"]);
      cache.set(entry1);
      cache.set(entry2);
      expect(cache.get("42")).toEqual(entry2);
    });
  });

  describe("invalidate()", () => {
    it("removes specific entry by parentId", () => {
      const cache = new SubIssueCache();
      cache.set(makeEntry("42", ["10"]));
      cache.set(makeEntry("43", ["20"]));
      cache.invalidate("42");
      expect(cache.get("42")).toBeNull();
      expect(cache.get("43")).not.toBeNull();
    });

    it("does nothing for unknown parentId", () => {
      const cache = new SubIssueCache();
      // Should not throw
      expect(() => cache.invalidate("999")).not.toThrow();
    });
  });

  describe("invalidateAll()", () => {
    it("clears all entries", () => {
      const cache = new SubIssueCache();
      cache.set(makeEntry("1", ["a"]));
      cache.set(makeEntry("2", ["b"]));
      cache.set(makeEntry("3", ["c"]));
      cache.invalidateAll();
      expect(cache.get("1")).toBeNull();
      expect(cache.get("2")).toBeNull();
      expect(cache.get("3")).toBeNull();
    });

    it("works on empty cache", () => {
      const cache = new SubIssueCache();
      expect(() => cache.invalidateAll()).not.toThrow();
    });
  });

  describe("getAllEntries()", () => {
    it("returns all non-expired entries", () => {
      const cache = new SubIssueCache(10000);
      const e1 = makeEntry("1", ["a"]);
      const e2 = makeEntry("2", ["b"]);
      const e3 = makeEntry("3", ["c"]);
      cache.set(e1);
      cache.set(e2);
      cache.set(e3);
      const entries = cache.getAllEntries();
      expect(entries).toHaveLength(3);
      expect(entries).toContainEqual(e1);
      expect(entries).toContainEqual(e2);
      expect(entries).toContainEqual(e3);
    });

    it("excludes expired entries without explicit invalidation", () => {
      const cache = new SubIssueCache(5000);
      const e1 = makeEntry("1", ["a"]);
      cache.set(e1);

      vi.advanceTimersByTime(3000);

      const e2 = makeEntry("2", ["b"]);
      cache.set(e2);

      // Advance 3 more seconds: e1 is now expired (6s total), e2 is fresh (3s)
      vi.advanceTimersByTime(3000);

      const entries = cache.getAllEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual(e2);
    });

    it("returns empty array for empty cache", () => {
      const cache = new SubIssueCache();
      expect(cache.getAllEntries()).toEqual([]);
    });
  });

  describe("constructor", () => {
    it("accepts custom TTL", () => {
      const cache = new SubIssueCache(1000); // 1 second TTL
      const entry = makeEntry("42", ["10"]);
      cache.set(entry);

      vi.advanceTimersByTime(1001);
      expect(cache.get("42")).toBeNull();
    });

    it("uses default TTL of 5 minutes (300000ms)", () => {
      const cache = new SubIssueCache(); // Default TTL
      const entry = makeEntry("42", ["10"]);
      cache.set(entry);

      // Just under 5 minutes: still cached
      vi.advanceTimersByTime(299999);
      expect(cache.get("42")).not.toBeNull();

      // Past 5 minutes: expired
      vi.advanceTimersByTime(2);
      expect(cache.get("42")).toBeNull();
    });
  });
});
