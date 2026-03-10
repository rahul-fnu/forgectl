import { describe, it, expect } from "vitest";
import { parseSlashCommand, buildHelpMessage, buildErrorMessage } from "../../src/github/commands.js";

describe("parseSlashCommand", () => {
  it('parses "/forgectl run my-workflow" with args', () => {
    const result = parseSlashCommand("/forgectl run my-workflow");
    expect(result).toEqual({ command: "run", args: ["my-workflow"] });
  });

  it('parses "/forgectl rerun" with no args', () => {
    const result = parseSlashCommand("/forgectl rerun");
    expect(result).toEqual({ command: "rerun", args: [] });
  });

  it('parses "/forgectl stop"', () => {
    const result = parseSlashCommand("/forgectl stop");
    expect(result).toEqual({ command: "stop", args: [] });
  });

  it('parses "/forgectl status"', () => {
    const result = parseSlashCommand("/forgectl status");
    expect(result).toEqual({ command: "status", args: [] });
  });

  it('parses "/forgectl approve"', () => {
    const result = parseSlashCommand("/forgectl approve");
    expect(result).toEqual({ command: "approve", args: [] });
  });

  it('parses "/forgectl reject"', () => {
    const result = parseSlashCommand("/forgectl reject");
    expect(result).toEqual({ command: "reject", args: [] });
  });

  it('parses "/forgectl help"', () => {
    const result = parseSlashCommand("/forgectl help");
    expect(result).toEqual({ command: "help", args: [] });
  });

  it("returns null for a regular comment", () => {
    const result = parseSlashCommand("just a regular comment");
    expect(result).toBeNull();
  });

  it("returns null for unknown command", () => {
    const result = parseSlashCommand("/forgectl invalidcmd");
    expect(result).toBeNull();
  });

  it("extracts command from middle of body", () => {
    const result = parseSlashCommand("some text\n/forgectl run\nmore text");
    expect(result).toEqual({ command: "run", args: [] });
  });

  it("parses command with multiple args", () => {
    const result = parseSlashCommand("/forgectl run my-workflow --fast");
    expect(result).toEqual({ command: "run", args: ["my-workflow", "--fast"] });
  });
});

describe("buildHelpMessage", () => {
  it("returns a string listing all commands", () => {
    const msg = buildHelpMessage();
    expect(msg).toContain("run");
    expect(msg).toContain("rerun");
    expect(msg).toContain("stop");
    expect(msg).toContain("status");
    expect(msg).toContain("approve");
    expect(msg).toContain("reject");
    expect(msg).toContain("help");
  });
});

describe("buildErrorMessage", () => {
  it("includes the reason in the message", () => {
    const msg = buildErrorMessage("permission denied");
    expect(msg).toContain("permission denied");
  });
});
