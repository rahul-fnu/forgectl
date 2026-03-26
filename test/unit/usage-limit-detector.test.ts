import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  UsageLimitDetector,
  type UsageLimitDetectorConfig,
} from "src/agent/usage-limit-detector.ts";

function makeConfig(
  overrides: Partial<UsageLimitDetectorConfig> = {}
): UsageLimitDetectorConfig {
  return {
    enabled: true,
    patterns: [],
    ...overrides,
  };
}

describe("UsageLimitDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("checkOutput", () => {
    it("detects exact Claude CLI usage limit output", () => {
      const detector = new UsageLimitDetector(makeConfig());
      const output =
        "Error: Your account has reached its monthly plan quota. Please upgrade or wait.";
      const result = detector.checkOutput(output);
      expect(result).not.toBeNull();
      expect(result!.detected).toBe(true);
      expect(result!.reason).toBe("pattern_match");
      expect(result!.matchedPattern).toBe("your account has reached");
    });

    it("matches case-insensitively", () => {
      const detector = new UsageLimitDetector(makeConfig());
      const result = detector.checkOutput("RATE LIMIT exceeded for your org");
      expect(result).not.toBeNull();
      expect(result!.detected).toBe(true);
      expect(result!.matchedPattern).toBe("rate limit");
    });

    it("does not false-positive on normal output containing 'limit'", () => {
      const detector = new UsageLimitDetector(makeConfig());
      const normalOutputs = [
        "Setting memory limit to 4GB",
        "Character limit: 1000",
        "The speed limit is 60mph",
        "limit = config.maxItems || 100",
        "git log --limit=50",
      ];
      for (const output of normalOutputs) {
        expect(detector.checkOutput(output)).toBeNull();
      }
    });

    it("returns first matching pattern when multiple match", () => {
      const detector = new UsageLimitDetector(makeConfig());
      const output = "Rate limit hit. Too many requests. Quota exceeded.";
      const result = detector.checkOutput(output);
      expect(result).not.toBeNull();
      expect(result!.matchedPattern).toBe("rate limit");
    });

    it("truncates rawOutput to 500 chars", () => {
      const detector = new UsageLimitDetector(makeConfig());
      const longOutput = "usage limit " + "x".repeat(600);
      const result = detector.checkOutput(longOutput);
      expect(result).not.toBeNull();
      expect(result!.rawOutput!.length).toBe(500);
    });

    it("uses custom patterns when provided", () => {
      const detector = new UsageLimitDetector(
        makeConfig({ patterns: ["custom error"] })
      );
      expect(detector.checkOutput("custom error occurred")).not.toBeNull();
      expect(detector.checkOutput("usage limit")).toBeNull();
    });

    it("includes timestamp in result", () => {
      const detector = new UsageLimitDetector(makeConfig());
      const result = detector.checkOutput("rate limit exceeded");
      expect(result!.timestamp).toBe("2026-01-15T12:00:00.000Z");
    });
  });

  describe("checkExitCode", () => {
    it("detects configured exit codes", () => {
      const detector = new UsageLimitDetector(
        makeConfig({ exitCodes: [42, 137] })
      );
      const result = detector.checkExitCode(42);
      expect(result).not.toBeNull();
      expect(result!.detected).toBe(true);
      expect(result!.reason).toBe("exit_code");
    });

    it("returns null for non-matching exit codes", () => {
      const detector = new UsageLimitDetector(
        makeConfig({ exitCodes: [42] })
      );
      expect(detector.checkExitCode(0)).toBeNull();
      expect(detector.checkExitCode(1)).toBeNull();
    });

    it("returns null when no exit codes configured", () => {
      const detector = new UsageLimitDetector(makeConfig());
      expect(detector.checkExitCode(42)).toBeNull();
    });
  });

  describe("checkHang", () => {
    it("detects hang when timeout exceeded", () => {
      const detector = new UsageLimitDetector(
        makeConfig({ hangTimeoutMs: 5000 })
      );
      const lastOutputAt = Date.now() - 6000;
      const result = detector.checkHang(lastOutputAt);
      expect(result).not.toBeNull();
      expect(result!.detected).toBe(true);
      expect(result!.reason).toBe("hang_timeout");
    });

    it("returns null when within timeout", () => {
      const detector = new UsageLimitDetector(
        makeConfig({ hangTimeoutMs: 5000 })
      );
      const lastOutputAt = Date.now() - 3000;
      expect(detector.checkHang(lastOutputAt)).toBeNull();
    });

    it("returns null when no hangTimeoutMs configured", () => {
      const detector = new UsageLimitDetector(makeConfig());
      const lastOutputAt = Date.now() - 999999;
      expect(detector.checkHang(lastOutputAt)).toBeNull();
    });
  });

  describe("config disabled", () => {
    it("never detects when disabled", () => {
      const detector = new UsageLimitDetector(
        makeConfig({
          enabled: false,
          exitCodes: [42],
          hangTimeoutMs: 1,
        })
      );
      expect(detector.checkOutput("rate limit exceeded")).toBeNull();
      expect(detector.checkExitCode(42)).toBeNull();
      expect(detector.checkHang(0)).toBeNull();
    });
  });
});
