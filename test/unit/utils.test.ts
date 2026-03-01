import { describe, it, expect } from "vitest";
import { expandTemplate } from "../../src/utils/template.js";
import { slugify } from "../../src/utils/slug.js";
import { parseDuration, formatDuration } from "../../src/utils/duration.js";
import { Timer } from "../../src/utils/timer.js";
import { hashString } from "../../src/utils/hash.js";

describe("expandTemplate", () => {
  it("expands simple variables", () => {
    expect(expandTemplate("Hello {{name}}", { name: "world" })).toBe("Hello world");
  });

  it("expands multiple variables", () => {
    expect(expandTemplate("{{a}} and {{b}}", { a: "foo", b: "bar" })).toBe("foo and bar");
  });

  it("expands nested keys", () => {
    expect(expandTemplate("{{commit.prefix}} {{summary}}", {
      commit: { prefix: "[forge]" },
      summary: "test"
    })).toBe("[forge] test");
  });

  it("leaves unresolved placeholders as-is", () => {
    expect(expandTemplate("{{unknown}} stays", {})).toBe("{{unknown}} stays");
  });

  it("handles null values in nested path", () => {
    expect(expandTemplate("{{a.b.c}}", { a: null })).toBe("{{a.b.c}}");
  });

  it("converts numbers to strings", () => {
    expect(expandTemplate("count: {{n}}", { n: 42 })).toBe("count: 42");
  });

  it("handles empty template", () => {
    expect(expandTemplate("", { a: "b" })).toBe("");
  });
});

describe("slugify", () => {
  it("converts to lowercase and replaces spaces with hyphens", () => {
    expect(slugify("Add rate limiting")).toBe("add-rate-limiting");
  });

  it("removes special characters", () => {
    expect(slugify("Add rate limiting to /api/upload")).toBe("add-rate-limiting-to-apiupload");
  });

  it("collapses multiple hyphens", () => {
    expect(slugify("foo---bar")).toBe("foo-bar");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  it("respects maxLength", () => {
    expect(slugify("a very long task description that should be truncated", 20)).toBe("a-very-long-task-des");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("uses default maxLength of 50", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBe(50);
  });
});

describe("parseDuration", () => {
  it("parses seconds", () => {
    expect(parseDuration("30s")).toBe(30000);
  });

  it("parses minutes", () => {
    expect(parseDuration("5m")).toBe(300000);
  });

  it("parses hours", () => {
    expect(parseDuration("1h")).toBe(3600000);
  });

  it("parses larger values", () => {
    expect(parseDuration("90s")).toBe(90000);
    expect(parseDuration("30m")).toBe(1800000);
  });

  it("throws on invalid input", () => {
    expect(() => parseDuration("abc")).toThrow("Invalid duration");
    expect(() => parseDuration("30")).toThrow("Invalid duration");
    expect(() => parseDuration("30d")).toThrow("Invalid duration");
    expect(() => parseDuration("")).toThrow("Invalid duration");
  });
});

describe("formatDuration", () => {
  it("formats seconds only", () => {
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(45000)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(167000)).toBe("2m 47s");
  });

  it("formats exact minutes", () => {
    expect(formatDuration(120000)).toBe("2m");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(3900000)).toBe("1h 5m");
  });

  it("formats exact hours", () => {
    expect(formatDuration(3600000)).toBe("1h");
  });

  it("formats zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });
});

describe("Timer", () => {
  it("tracks elapsed time", async () => {
    const timer = new Timer();
    await new Promise(r => setTimeout(r, 50));
    expect(timer.elapsed()).toBeGreaterThanOrEqual(40);
  });

  it("resets correctly", async () => {
    const timer = new Timer();
    await new Promise(r => setTimeout(r, 50));
    timer.reset();
    expect(timer.elapsed()).toBeLessThan(50);
  });
});

describe("hashString", () => {
  it("returns consistent 12-char hex hash", () => {
    const hash = hashString("test");
    expect(hash).toHaveLength(12);
    expect(hashString("test")).toBe(hash);
  });

  it("returns different hashes for different input", () => {
    expect(hashString("foo")).not.toBe(hashString("bar"));
  });
});
