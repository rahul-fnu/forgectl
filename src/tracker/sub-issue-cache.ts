/**
 * TTL cache for sub-issue relationships.
 * Stores parent→children mappings with expiry to avoid stale data.
 */

export interface SubIssueEntry {
  /** Issue number string for the parent issue, e.g. "42" */
  parentId: string;
  /** Issue number strings of direct children */
  childIds: string[];
  /** childId -> GitHub state ("open"/"closed") */
  childStates: Map<string, string>;
  /** Date.now() at fetch time */
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class SubIssueCache {
  private readonly ttlMs: number;
  private entries: Map<string, SubIssueEntry>;

  constructor(ttlMs?: number) {
    this.ttlMs = ttlMs ?? DEFAULT_TTL_MS;
    this.entries = new Map();
  }

  /**
   * Get a cached entry for the given parentId.
   * Returns null if the entry doesn't exist or has expired (and lazily deletes it).
   */
  get(parentId: string): SubIssueEntry | null {
    const entry = this.entries.get(parentId);
    if (!entry) return null;

    const age = Date.now() - entry.fetchedAt;
    if (age >= this.ttlMs) {
      this.entries.delete(parentId);
      return null;
    }

    return entry;
  }

  /**
   * Store an entry. Overwrites any existing entry for the same parentId.
   */
  set(entry: SubIssueEntry): void {
    this.entries.set(entry.parentId, entry);
  }

  /**
   * Remove a specific entry by parentId.
   */
  invalidate(parentId: string): void {
    this.entries.delete(parentId);
  }

  /**
   * Remove all entries from the cache.
   */
  invalidateAll(): void {
    this.entries.clear();
  }

  /**
   * Returns all non-expired entries.
   * Used by the scheduler to populate terminalIssueIds from fresh cached data.
   * Performs lazy cleanup of expired entries as a side effect.
   */
  getAllEntries(): SubIssueEntry[] {
    const now = Date.now();
    const result: SubIssueEntry[] = [];

    for (const [parentId, entry] of this.entries) {
      const age = now - entry.fetchedAt;
      if (age >= this.ttlMs) {
        this.entries.delete(parentId);
      } else {
        result.push(entry);
      }
    }

    return result;
  }
}
