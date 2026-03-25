import { describe, expect, it } from "vitest";
import { parseTunnelUrl } from "../../src/cli/tunnel.js";
import { ConfigSchema } from "../../src/config/schema.js";

describe("parseTunnelUrl", () => {
  it("extracts URL from cloudflared output", () => {
    const output =
      "2024-01-01T00:00:00Z INF +--------------------------------------------------------------------------------------------+\n" +
      "2024-01-01T00:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\n" +
      "2024-01-01T00:00:00Z INF |  https://some-random-name.trycloudflare.com                                                |\n" +
      "2024-01-01T00:00:00Z INF +--------------------------------------------------------------------------------------------+\n";
    expect(parseTunnelUrl(output)).toBe("https://some-random-name.trycloudflare.com");
  });

  it("returns null when no URL is present", () => {
    expect(parseTunnelUrl("some random output")).toBeNull();
  });

  it("handles URL with numbers and hyphens in subdomain", () => {
    const output = "INF https://abc-123-def.trycloudflare.com ready";
    expect(parseTunnelUrl(output)).toBe("https://abc-123-def.trycloudflare.com");
  });

  it("returns null for empty string", () => {
    expect(parseTunnelUrl("")).toBeNull();
  });
});

describe("config schema - daemon.tunnel", () => {
  it("accepts default daemon config", () => {
    const result = ConfigSchema.parse({});
    expect(result.daemon.tunnel.enabled).toBe(false);
    expect(result.daemon.tunnel.hostname).toBeUndefined();
  });

  it("accepts tunnel enabled with hostname", () => {
    const result = ConfigSchema.parse({
      daemon: {
        tunnel: {
          enabled: true,
          hostname: "my-tunnel.example.com",
        },
      },
    });
    expect(result.daemon.tunnel.enabled).toBe(true);
    expect(result.daemon.tunnel.hostname).toBe("my-tunnel.example.com");
  });

  it("accepts tunnel enabled without hostname", () => {
    const result = ConfigSchema.parse({
      daemon: {
        tunnel: {
          enabled: true,
        },
      },
    });
    expect(result.daemon.tunnel.enabled).toBe(true);
    expect(result.daemon.tunnel.hostname).toBeUndefined();
  });

  it("rejects non-boolean enabled", () => {
    expect(() =>
      ConfigSchema.parse({
        daemon: { tunnel: { enabled: "yes" } },
      })
    ).toThrow();
  });
});
