import { describe, it, expect, vi } from "vitest";
import {
  decomposeToIssues,
  buildDecompositionPrompt,
  parseDecompositionResponse,
} from "../../src/planner/decompose-to-issues.js";
import type {
  IssueCreator,
  LLMCallFn,
  DecompositionLLMResult,
} from "../../src/planner/decompose-to-issues.js";

function makeLLMResponse(result: DecompositionLLMResult): string {
  return JSON.stringify(result);
}

function makeDefaultDecomposition(): DecompositionLLMResult {
  return {
    parent: {
      title: "Add user authentication",
      description: "Implement full auth flow for the application",
    },
    children: [
      {
        title: "Create user model and DB schema",
        description: "Set up the user table and ORM model",
        blocked_by: [],
      },
      {
        title: "Implement login/signup endpoints",
        description: "REST API for auth",
        blocked_by: [0],
      },
      {
        title: "Verification and rollup",
        description: "Run full test suite and verify integration",
        blocked_by: [0, 1],
      },
    ],
  };
}

function mockIssueCreator() {
  let issueCounter = 0;
  const createdIssues: Array<{ title: string; description: string; parentId?: string }> = [];
  const createdRelations: Array<{ blockingId: string; blockedId: string }> = [];

  const creator: IssueCreator = {
    createIssue: vi.fn(async (title: string, description: string) => {
      issueCounter++;
      const id = `PARENT-${issueCounter}`;
      createdIssues.push({ title, description });
      return id;
    }),
    createSubIssue: vi.fn(async (title: string, description: string, parentId: string) => {
      issueCounter++;
      const id = `CHILD-${issueCounter}`;
      createdIssues.push({ title, description, parentId });
      return id;
    }),
    createBlockingRelation: vi.fn(async (blockingId: string, blockedId: string) => {
      createdRelations.push({ blockingId, blockedId });
    }),
  };

  return { creator, createdIssues, createdRelations };
}

const defaultConfig = {
  planner: {
    decomposition_model: "claude-haiku-4-5-20251001",
    max_sub_issues: 10,
  },
};

describe("buildDecompositionPrompt", () => {
  it("includes the prompt text", () => {
    const result = buildDecompositionPrompt({ prompt: "Build a REST API" }, 10);
    expect(result).toContain("Build a REST API");
  });

  it("includes repo slug when provided", () => {
    const result = buildDecompositionPrompt(
      { prompt: "Build API", repoSlug: "owner/repo" },
      10,
    );
    expect(result).toContain("**Repo:** https://github.com/owner/repo");
  });

  it("includes stack hint when provided", () => {
    const result = buildDecompositionPrompt(
      { prompt: "Build API", stackHint: "Node.js + TypeScript" },
      10,
    );
    expect(result).toContain("Node.js + TypeScript");
  });

  it("includes max sub-issues in the prompt", () => {
    const result = buildDecompositionPrompt({ prompt: "Build API" }, 5);
    expect(result).toContain("Maximum 5 sub-issues");
  });
});

describe("parseDecompositionResponse", () => {
  it("parses valid JSON", () => {
    const decomp = makeDefaultDecomposition();
    const result = parseDecompositionResponse(JSON.stringify(decomp), 10);
    expect(result.parent.title).toBe("Add user authentication");
    expect(result.children).toHaveLength(3);
    expect(result.children[1].blocked_by).toEqual([0]);
  });

  it("strips markdown fences", () => {
    const decomp = makeDefaultDecomposition();
    const wrapped = "```json\n" + JSON.stringify(decomp) + "\n```";
    const result = parseDecompositionResponse(wrapped, 10);
    expect(result.children).toHaveLength(3);
  });

  it("extracts JSON from surrounding text", () => {
    const decomp = makeDefaultDecomposition();
    const withText = "Here is the decomposition:\n" + JSON.stringify(decomp) + "\nDone.";
    const result = parseDecompositionResponse(withText, 10);
    expect(result.parent.title).toBe("Add user authentication");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseDecompositionResponse("not json", 10)).toThrow();
  });

  it("throws on missing parent", () => {
    expect(() =>
      parseDecompositionResponse(JSON.stringify({ children: [{ title: "a", description: "b", blocked_by: [] }] }), 10),
    ).toThrow("missing valid 'parent'");
  });

  it("throws on empty children", () => {
    expect(() =>
      parseDecompositionResponse(
        JSON.stringify({ parent: { title: "P", description: "D" }, children: [] }),
        10,
      ),
    ).toThrow("at least one child");
  });

  it("truncates children to max_sub_issues", () => {
    const decomp = makeDefaultDecomposition();
    const result = parseDecompositionResponse(JSON.stringify(decomp), 2);
    expect(result.children).toHaveLength(2);
  });

  it("filters out invalid blocked_by indices", () => {
    const decomp: DecompositionLLMResult = {
      parent: { title: "P", description: "D" },
      children: [
        { title: "A", description: "a", blocked_by: [5, -1, 0] },
        { title: "B", description: "b", blocked_by: [0] },
      ],
    };
    const result = parseDecompositionResponse(JSON.stringify(decomp), 10);
    expect(result.children[0].blocked_by).toEqual([]);
    expect(result.children[1].blocked_by).toEqual([0]);
  });

  it("filters out self-referencing blocked_by", () => {
    const decomp: DecompositionLLMResult = {
      parent: { title: "P", description: "D" },
      children: [
        { title: "A", description: "a", blocked_by: [0] },
      ],
    };
    const result = parseDecompositionResponse(JSON.stringify(decomp), 10);
    expect(result.children[0].blocked_by).toEqual([]);
  });
});

describe("decomposeToIssues", () => {
  it("creates parent issue and sub-issues with blocking relations", async () => {
    const decomp = makeDefaultDecomposition();
    const { creator, createdRelations } = mockIssueCreator();

    const llmCall: LLMCallFn = vi.fn(async () => makeLLMResponse(decomp));

    const result = await decomposeToIssues(
      { prompt: "Add user authentication" },
      creator,
      llmCall,
      defaultConfig,
    );

    expect(result.parentIdentifier).toBe("PARENT-1");
    expect(result.childIdentifiers).toHaveLength(3);
    expect(result.childIdentifiers).toEqual(["CHILD-2", "CHILD-3", "CHILD-4"]);

    expect(creator.createIssue).toHaveBeenCalledOnce();
    expect(creator.createIssue).toHaveBeenCalledWith(
      "Add user authentication",
      "Implement full auth flow for the application",
    );

    expect(creator.createSubIssue).toHaveBeenCalledTimes(3);
    expect(creator.createSubIssue).toHaveBeenCalledWith(
      "Create user model and DB schema",
      "Set up the user table and ORM model",
      "PARENT-1",
    );

    // child[1] blocked_by [0] => CHILD-2 blocks CHILD-3
    // child[2] blocked_by [0, 1] => CHILD-2 blocks CHILD-4, CHILD-3 blocks CHILD-4
    expect(createdRelations).toHaveLength(3);
    expect(createdRelations).toContainEqual({ blockingId: "CHILD-2", blockedId: "CHILD-3" });
    expect(createdRelations).toContainEqual({ blockingId: "CHILD-2", blockedId: "CHILD-4" });
    expect(createdRelations).toContainEqual({ blockingId: "CHILD-3", blockedId: "CHILD-4" });
  });

  it("passes correct model from config to LLM call", async () => {
    const decomp = makeDefaultDecomposition();
    const { creator } = mockIssueCreator();
    const llmCall: LLMCallFn = vi.fn(async () => makeLLMResponse(decomp));

    await decomposeToIssues(
      { prompt: "Build API" },
      creator,
      llmCall,
      { planner: { decomposition_model: "custom-model", max_sub_issues: 10 } },
    );

    expect(llmCall).toHaveBeenCalledWith(expect.any(String), "custom-model");
  });

  it("handles single-task decomposition (one child)", async () => {
    const decomp: DecompositionLLMResult = {
      parent: { title: "Fix typo", description: "Fix typo in README" },
      children: [
        { title: "Fix typo in README", description: "Change 'teh' to 'the'", blocked_by: [] },
      ],
    };
    const { creator, createdRelations } = mockIssueCreator();
    const llmCall: LLMCallFn = vi.fn(async () => makeLLMResponse(decomp));

    const result = await decomposeToIssues(
      { prompt: "Fix typo" },
      creator,
      llmCall,
      defaultConfig,
    );

    expect(result.childIdentifiers).toHaveLength(1);
    expect(createdRelations).toHaveLength(0);
  });

  it("includes repo slug in decomposition prompt", async () => {
    const decomp = makeDefaultDecomposition();
    const { creator } = mockIssueCreator();
    const llmCall: LLMCallFn = vi.fn(async () => makeLLMResponse(decomp));

    await decomposeToIssues(
      { prompt: "Build API", repoSlug: "owner/repo" },
      creator,
      llmCall,
      defaultConfig,
    );

    const calledPrompt = (llmCall as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledPrompt).toContain("**Repo:** https://github.com/owner/repo");
  });
});
