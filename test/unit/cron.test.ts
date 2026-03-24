import { describe, it, expect } from "vitest";
import { parseCron, cronMatches, type CronFields } from "../../src/orchestrator/cron.js";

describe("parseCron", () => {
  it("parses simple wildcard expression", () => {
    const fields = parseCron("* * * * *");
    expect(fields.minutes.size).toBe(60);
    expect(fields.hours.size).toBe(24);
    expect(fields.daysOfMonth.size).toBe(31);
    expect(fields.months.size).toBe(12);
    expect(fields.daysOfWeek.size).toBe(7);
  });

  it("parses specific values", () => {
    const fields = parseCron("30 14 1 6 3");
    expect(fields.minutes).toEqual(new Set([30]));
    expect(fields.hours).toEqual(new Set([14]));
    expect(fields.daysOfMonth).toEqual(new Set([1]));
    expect(fields.months).toEqual(new Set([6]));
    expect(fields.daysOfWeek).toEqual(new Set([3]));
  });

  it("parses ranges", () => {
    const fields = parseCron("0-5 * * * *");
    expect(fields.minutes).toEqual(new Set([0, 1, 2, 3, 4, 5]));
  });

  it("parses steps", () => {
    const fields = parseCron("*/15 * * * *");
    expect(fields.minutes).toEqual(new Set([0, 15, 30, 45]));
  });

  it("parses step with range", () => {
    const fields = parseCron("1-10/3 * * * *");
    expect(fields.minutes).toEqual(new Set([1, 4, 7, 10]));
  });

  it("parses lists", () => {
    const fields = parseCron("0,30 * * * *");
    expect(fields.minutes).toEqual(new Set([0, 30]));
  });

  it("parses combined list and range", () => {
    const fields = parseCron("0,10-12 * * * *");
    expect(fields.minutes).toEqual(new Set([0, 10, 11, 12]));
  });

  it("throws on invalid field count", () => {
    expect(() => parseCron("* * *")).toThrow("must have 5 fields");
  });

  it("throws on invalid value", () => {
    expect(() => parseCron("abc * * * *")).toThrow("Invalid value");
  });
});

describe("cronMatches", () => {
  it("matches when all fields align", () => {
    const fields = parseCron("30 14 15 6 *");
    // June 15, 2026, 14:30 - Sunday (day 0)
    const date = new Date(2026, 5, 15, 14, 30, 0);
    expect(cronMatches(fields, date)).toBe(true);
  });

  it("does not match when minute differs", () => {
    const fields = parseCron("30 14 * * *");
    const date = new Date(2026, 5, 15, 14, 31, 0);
    expect(cronMatches(fields, date)).toBe(false);
  });

  it("does not match when hour differs", () => {
    const fields = parseCron("30 14 * * *");
    const date = new Date(2026, 5, 15, 15, 30, 0);
    expect(cronMatches(fields, date)).toBe(false);
  });

  it("matches every-5-minutes pattern", () => {
    const fields = parseCron("*/5 * * * *");
    expect(cronMatches(fields, new Date(2026, 0, 1, 0, 0, 0))).toBe(true);
    expect(cronMatches(fields, new Date(2026, 0, 1, 0, 5, 0))).toBe(true);
    expect(cronMatches(fields, new Date(2026, 0, 1, 0, 3, 0))).toBe(false);
  });

  it("matches day-of-week", () => {
    const fields = parseCron("0 9 * * 1"); // Monday at 9:00
    // March 23, 2026 is a Monday
    const monday = new Date(2026, 2, 23, 9, 0, 0);
    expect(monday.getDay()).toBe(1);
    expect(cronMatches(fields, monday)).toBe(true);

    // March 24, 2026 is Tuesday
    const tuesday = new Date(2026, 2, 24, 9, 0, 0);
    expect(cronMatches(fields, tuesday)).toBe(false);
  });
});
