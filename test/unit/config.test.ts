import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../src/config/schema.js";
import { deepMerge } from "../../src/config/loader.js";

describe("ConfigSchema", () => {
  it("parses empty object with all defaults", () => {
    const config = ConfigSchema.parse({});

    expect(config.agent.type).toBe("claude-code");
    expect(config.agent.model).toBe("");
    expect(config.agent.max_turns).toBe(50);
    expect(config.agent.timeout).toBe("30m");
    expect(config.agent.flags).toEqual([]);

    expect(config.container.image).toBeUndefined();
    expect(config.container.resources.memory).toBe("4g");
    expect(config.container.resources.cpus).toBe(2);

    expect(config.repo.branch.template).toBe("forge/{{slug}}/{{ts}}");
    expect(config.repo.branch.base).toBe("main");
    expect(config.repo.exclude).toContain("node_modules/");
    expect(config.repo.exclude).toContain("dist/");
    // .git/objects/ must NOT be excluded — excluding it strips git history from the
    // workspace copy, breaking collectGitOutput (git rev-list returns empty).
    expect(config.repo.exclude).not.toContain(".git/objects/");

    expect(config.orchestration.mode).toBe("single");
    expect(config.orchestration.review.max_rounds).toBe(3);

    expect(config.commit.message.prefix).toBe("[forge]");
    expect(config.commit.author.name).toBe("forgectl");

    expect(config.output.dir).toBe("./forge-output");
    expect(config.output.log_dir).toBe(".forgectl/runs");
    expect(config.board.state_dir).toBe("~/.forgectl/board");
    expect(config.board.scheduler_tick_seconds).toBe(30);
    expect(config.board.max_concurrent_card_runs).toBe(2);
  });

  it("parses with overrides", () => {
    const config = ConfigSchema.parse({
      agent: {
        type: "codex",
        max_turns: 100,
        timeout: "1h",
      },
      container: {
        image: "custom/image:latest",
        resources: {
          memory: "8g",
          cpus: 4,
        },
      },
    });

    expect(config.agent.type).toBe("codex");
    expect(config.agent.max_turns).toBe(100);
    expect(config.agent.timeout).toBe("1h");
    expect(config.container.image).toBe("custom/image:latest");
    expect(config.container.resources.memory).toBe("8g");
    expect(config.container.resources.cpus).toBe(4);
  });

  it("rejects invalid agent type", () => {
    expect(() => ConfigSchema.parse({
      agent: { type: "invalid" }
    })).toThrow();
  });

  it("rejects invalid duration format", () => {
    expect(() => ConfigSchema.parse({
      agent: { timeout: "invalid" }
    })).toThrow();
  });

  it("rejects invalid network mode", () => {
    expect(() => ConfigSchema.parse({
      container: { network: { mode: "invalid" } }
    })).toThrow();
  });
});

describe("deepMerge", () => {
  it("merges nested objects", () => {
    const base = { a: { b: 1, c: 2 }, d: 3 };
    const overrides = { a: { b: 10 } };
    const result = deepMerge(base, overrides);
    expect(result).toEqual({ a: { b: 10, c: 2 }, d: 3 });
  });

  it("replaces arrays (does not merge)", () => {
    const base = { arr: [1, 2, 3] };
    const overrides = { arr: [4, 5] };
    const result = deepMerge(base, overrides);
    expect(result).toEqual({ arr: [4, 5] });
  });

  it("skips undefined values", () => {
    const base = { a: 1, b: 2 };
    const overrides = { a: undefined, b: 3 };
    const result = deepMerge(base, overrides);
    expect(result).toEqual({ a: 1, b: 3 });
  });

  it("handles deeply nested objects", () => {
    const base = { a: { b: { c: { d: 1, e: 2 } } } };
    const overrides = { a: { b: { c: { d: 10 } } } };
    const result = deepMerge(base, overrides);
    expect(result).toEqual({ a: { b: { c: { d: 10, e: 2 } } } });
  });

  it("overrides scalar with scalar", () => {
    const base = { a: "hello" };
    const overrides = { a: "world" };
    const result = deepMerge(base, overrides);
    expect(result).toEqual({ a: "world" });
  });

  it("does not mutate original objects", () => {
    const base = { a: { b: 1 } };
    const overrides = { a: { b: 2 } };
    deepMerge(base, overrides);
    expect(base.a.b).toBe(1);
  });
});
