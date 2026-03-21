import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveToken } from "../../src/tracker/token.js";

describe("resolveToken", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns literal tokens as-is", () => {
    expect(resolveToken("ghp_abc123")).toBe("ghp_abc123");
  });

  it("resolves env var references", () => {
    vi.stubEnv("MY_TOKEN", "resolved-value");
    expect(resolveToken("$MY_TOKEN")).toBe("resolved-value");
  });

  it("throws for unset env vars", () => {
    delete process.env.NONEXISTENT_VAR;
    expect(() => resolveToken("$NONEXISTENT_VAR")).toThrow('environment variable "NONEXISTENT_VAR" is not set');
  });

  it("resolves $gh via gh CLI", () => {
    // This test will fail if `gh` isn't installed, which is expected in CI.
    // We test the error path instead — it should throw with a clear message.
    // The success path is covered by integration/manual testing.
    try {
      const token = resolveToken("$gh");
      // If gh is installed and authenticated, we get a token
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);
    } catch (err) {
      // If gh is not installed or not authenticated, we get a clear error
      expect((err as Error).message).toContain("gh auth token");
    }
  });
});
