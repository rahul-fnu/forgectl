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

  it("resolves $linear from LINEAR_API_KEY env var", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_api_test123");
    expect(resolveToken("$linear")).toBe("lin_api_test123");
  });

  it("throws clear error when $linear used without LINEAR_API_KEY", () => {
    delete process.env.LINEAR_API_KEY;
    expect(() => resolveToken("$linear")).toThrow("LINEAR_API_KEY");
    expect(() => resolveToken("$linear")).toThrow("Settings > Account > Security");
  });

  it("resolves $LINEAR_API_KEY as standard env var", () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_api_direct");
    expect(resolveToken("$LINEAR_API_KEY")).toBe("lin_api_direct");
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
