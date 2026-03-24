import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createKGDatabase, type KGDatabase } from "../../src/kg/storage.js";
import {
  saveConvention,
  getConventionsForModules,
  formatConventionsForContext,
  extractModulePrefixes,
  type Convention,
} from "../../src/kg/conventions.js";

describe("Conventions", () => {
  let db: KGDatabase;

  beforeEach(() => {
    db = createKGDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("getConventionsForModules", () => {
    it("filters by module and confidence", () => {
      saveConvention(db, {
        module: "src/storage",
        pattern: "factory_function",
        description: "use factory function pattern",
        confidence: 0.85,
        source: "mined",
        occurrences: 5,
        lastSeen: "2026-03-01T00:00:00Z",
      });
      saveConvention(db, {
        module: "src/agent",
        pattern: "adapter_pattern",
        description: "use adapter pattern",
        confidence: 0.9,
        source: "mined",
        occurrences: 3,
        lastSeen: "2026-03-01T00:00:00Z",
      });
      saveConvention(db, {
        module: "src/storage",
        pattern: "low_confidence",
        description: "something uncertain",
        confidence: 0.3,
        source: "mined",
        occurrences: 1,
        lastSeen: "2026-03-01T00:00:00Z",
      });

      const result = getConventionsForModules(db, ["src/storage"], 0.7);
      expect(result).toHaveLength(1);
      expect(result[0].pattern).toBe("factory_function");
    });

    it("includes global conventions (module = '*')", () => {
      saveConvention(db, {
        module: "*",
        pattern: "async_await",
        description: "use async/await everywhere",
        confidence: 0.95,
        source: "mined",
        occurrences: 10,
        lastSeen: "2026-03-01T00:00:00Z",
      });
      saveConvention(db, {
        module: "src/storage",
        pattern: "factory_function",
        description: "use factory function pattern",
        confidence: 0.85,
        source: "mined",
        occurrences: 5,
        lastSeen: "2026-03-01T00:00:00Z",
      });

      const result = getConventionsForModules(db, ["src/storage"], 0.7);
      expect(result).toHaveLength(2);
    });

    it("returns empty for no matching modules", () => {
      saveConvention(db, {
        module: "src/storage",
        pattern: "factory_function",
        description: "use factory function pattern",
        confidence: 0.85,
        source: "mined",
        occurrences: 5,
        lastSeen: "2026-03-01T00:00:00Z",
      });

      const result = getConventionsForModules(db, ["src/agent"], 0.7);
      expect(result).toHaveLength(0);
    });

    it("returns empty for empty modules array", () => {
      const result = getConventionsForModules(db, [], 0.7);
      expect(result).toHaveLength(0);
    });
  });

  describe("formatConventionsForContext", () => {
    it("formats conventions grouped by module", () => {
      const conventions: Convention[] = [
        {
          id: 1,
          module: "src/storage",
          pattern: "factory_function",
          description: "use factory function pattern (createXxxRepository)",
          confidence: 0.85,
          source: "mined",
          occurrences: 5,
          lastSeen: "2026-03-01T00:00:00Z",
        },
        {
          id: 2,
          module: "src/storage",
          pattern: "error_handling",
          description: "try/catch with logger.warn for non-fatal",
          confidence: 0.8,
          source: "review",
          occurrences: 3,
          lastSeen: "2026-03-01T00:00:00Z",
        },
      ];

      const text = formatConventionsForContext(conventions);
      expect(text).toContain("## Conventions");
      expect(text).toContain("When working in src/storage/");
      expect(text).toContain("factory function pattern");
      expect(text).toContain("logger.warn");
    });

    it("returns empty string for no conventions", () => {
      expect(formatConventionsForContext([])).toBe("");
    });

    it("labels global conventions correctly", () => {
      const conventions: Convention[] = [
        {
          id: 1,
          module: "*",
          pattern: "async_await",
          description: "use async/await everywhere",
          confidence: 0.95,
          source: "mined",
          occurrences: 10,
          lastSeen: "2026-03-01T00:00:00Z",
        },
      ];

      const text = formatConventionsForContext(conventions);
      expect(text).toContain("Global:");
    });
  });

  describe("extractModulePrefixes", () => {
    it("extracts directory-based prefixes", () => {
      const prefixes = extractModulePrefixes([
        "src/storage/repositories/runs.ts",
        "src/agent/session.ts",
      ]);
      expect(prefixes).toContain("src");
      expect(prefixes).toContain("src/storage");
      expect(prefixes).toContain("src/storage/repositories");
      expect(prefixes).toContain("src/agent");
    });

    it("returns empty for empty input", () => {
      expect(extractModulePrefixes([])).toEqual([]);
    });
  });
});
