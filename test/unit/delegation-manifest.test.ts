import { describe, it, expect } from "vitest";
import {
  parseDelegationManifest,
  SubtaskSpecSchema,
  DelegationManifestSchema,
} from "../../src/orchestrator/delegation.js";
import type { SubtaskSpec } from "../../src/orchestrator/delegation.js";

describe("SubtaskSpecSchema", () => {
  it("accepts required id and task fields", () => {
    const result = SubtaskSpecSchema.parse({ id: "sub-1", task: "Do something" });
    expect(result.id).toBe("sub-1");
    expect(result.task).toBe("Do something");
  });

  it("accepts optional workflow and agent fields", () => {
    const result = SubtaskSpecSchema.parse({
      id: "sub-1",
      task: "Do something",
      workflow: "code",
      agent: "claude-code",
    });
    expect(result.workflow).toBe("code");
    expect(result.agent).toBe("claude-code");
  });

  it("rejects empty id", () => {
    expect(() => SubtaskSpecSchema.parse({ id: "", task: "Do something" })).toThrow();
  });

  it("rejects empty task", () => {
    expect(() => SubtaskSpecSchema.parse({ id: "sub-1", task: "" })).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() => SubtaskSpecSchema.parse({ id: "sub-1" })).toThrow();
    expect(() => SubtaskSpecSchema.parse({ task: "Do something" })).toThrow();
  });
});

describe("DelegationManifestSchema", () => {
  it("accepts a valid array of subtask specs", () => {
    const result = DelegationManifestSchema.parse([
      { id: "sub-1", task: "Task one" },
      { id: "sub-2", task: "Task two" },
    ]);
    expect(result).toHaveLength(2);
  });

  it("rejects empty array (min 1 enforced)", () => {
    expect(() => DelegationManifestSchema.parse([])).toThrow();
  });
});

describe("parseDelegationManifest", () => {
  it("returns null when stdout has no sentinel block", () => {
    const result = parseDelegationManifest("Just some normal agent output\nNo delegation here.");
    expect(result).toBeNull();
  });

  it("returns SubtaskSpec[] when stdout contains valid sentinel block", () => {
    const specs: SubtaskSpec[] = [
      { id: "sub-1", task: "Build the API endpoint" },
      { id: "sub-2", task: "Write tests for the endpoint" },
    ];
    const stdout = `Done analyzing the issue.
---DELEGATE---
${JSON.stringify(specs)}
---END-DELEGATE---
That's all I have to say.`;

    const result = parseDelegationManifest(stdout);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0].id).toBe("sub-1");
    expect(result![1].task).toBe("Write tests for the endpoint");
  });

  it("returns null when JSON is malformed", () => {
    const stdout = `---DELEGATE---
{ not valid json at all ][
---END-DELEGATE---`;
    expect(parseDelegationManifest(stdout)).toBeNull();
  });

  it("returns null when JSON does not match schema (missing id)", () => {
    const stdout = `---DELEGATE---
[{"task": "Do something"}]
---END-DELEGATE---`;
    expect(parseDelegationManifest(stdout)).toBeNull();
  });

  it("returns null when JSON does not match schema (missing task)", () => {
    const stdout = `---DELEGATE---
[{"id": "sub-1"}]
---END-DELEGATE---`;
    expect(parseDelegationManifest(stdout)).toBeNull();
  });

  it("returns null when JSON is empty array", () => {
    const stdout = `---DELEGATE---
[]
---END-DELEGATE---`;
    expect(parseDelegationManifest(stdout)).toBeNull();
  });

  it("uses only the first sentinel block when multiple exist", () => {
    const first: SubtaskSpec[] = [{ id: "first-1", task: "First block task" }];
    const second: SubtaskSpec[] = [
      { id: "second-1", task: "Second block task one" },
      { id: "second-2", task: "Second block task two" },
    ];
    const stdout = `---DELEGATE---
${JSON.stringify(first)}
---END-DELEGATE---
Some text in between.
---DELEGATE---
${JSON.stringify(second)}
---END-DELEGATE---`;

    const result = parseDelegationManifest(stdout);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].id).toBe("first-1");
  });

  it("handles sentinel block with surrounding whitespace and newlines", () => {
    const specs: SubtaskSpec[] = [{ id: "sub-1", task: "Some task" }];
    const stdout = `
---DELEGATE---

${JSON.stringify(specs)}

---END-DELEGATE---
  `;
    const result = parseDelegationManifest(stdout);
    expect(result).not.toBeNull();
    expect(result![0].id).toBe("sub-1");
  });

  it("works with non-manifest text before and after the sentinel block", () => {
    const specs: SubtaskSpec[] = [
      { id: "task-a", task: "Handle authentication", workflow: "code" },
    ];
    const stdout = `I've analyzed the repository and broken it down into subtasks.

Here is my delegation plan:
---DELEGATE---
${JSON.stringify(specs)}
---END-DELEGATE---

I'll now wait for the subtasks to complete before synthesizing results.`;

    const result = parseDelegationManifest(stdout);
    expect(result).not.toBeNull();
    expect(result![0].agent).toBeUndefined();
    expect(result![0].workflow).toBe("code");
  });

  it("returns SubtaskSpec with optional fields populated", () => {
    const specs: SubtaskSpec[] = [
      {
        id: "sub-1",
        task: "Build component",
        workflow: "ui-work",
        agent: "claude-code",
      },
    ];
    const stdout = `---DELEGATE---
${JSON.stringify(specs)}
---END-DELEGATE---`;
    const result = parseDelegationManifest(stdout);
    expect(result).not.toBeNull();
    expect(result![0].workflow).toBe("ui-work");
    expect(result![0].agent).toBe("claude-code");
  });

  it("returns null when sentinel delimiters are partial/incomplete", () => {
    const result = parseDelegationManifest(`---DELEGATE---
[{"id": "sub-1", "task": "Task"}]`);
    expect(result).toBeNull();
  });
});
