import type { ForgectlConfig } from "../config/schema.js";

/**
 * Structured decomposition result from the LLM.
 */
export interface DecompositionLLMResult {
  parent: {
    title: string;
    description: string;
  };
  children: Array<{
    title: string;
    description: string;
    blocked_by: number[];
  }>;
}

/**
 * Input for the decompose-to-issues flow.
 */
export interface DecomposeInput {
  prompt: string;
  repoSlug?: string;
  stackHint?: string;
}

/**
 * Minimal tracker interface needed for issue creation.
 * Matches a subset of TrackerAdapter plus Linear-specific operations.
 */
export interface IssueCreator {
  createIssue(title: string, description: string, labels?: string[]): Promise<string>;
  createSubIssue(title: string, description: string, parentId: string): Promise<string>;
  createBlockingRelation(blockingIssueId: string, blockedIssueId: string): Promise<void>;
}

/**
 * A function that calls an LLM with a prompt and returns the response text.
 */
export type LLMCallFn = (prompt: string, model: string) => Promise<string>;

/**
 * Result of the decompose-to-issues flow.
 */
export interface DecomposeResult {
  parentIdentifier: string;
  childIdentifiers: string[];
}

/**
 * Build the decomposition prompt sent to the LLM.
 */
export function buildDecompositionPrompt(input: DecomposeInput, maxSubIssues: number): string {
  const parts: string[] = [];

  parts.push(`You are a task decomposition agent. Analyze the request below and decide whether it is a single task or needs to be broken into sub-issues.

Rules:
- If it's a single, focused task: return one child (no parent decomposition needed, but still use the parent/children format with one child).
- If it's complex: return a parent issue and ordered sub-issues with dependencies.
- Keep each sub-issue small enough for one agent session (1-2 files, one feature).
- Order by dependency (foundations first, integrations last).
- Add a rollup/verification issue as the last child.
- If the prompt mentions creating a new project, the first sub-issue should be project scaffold.
- Maximum ${maxSubIssues} sub-issues.
- For each sub-issue, specify which other sub-issues it depends on using zero-based indices into the children array.`);

  if (input.repoSlug) {
    parts.push(`\nInclude "**Repo:** https://github.com/${input.repoSlug}" in each sub-issue description.`);
  }

  if (input.stackHint) {
    parts.push(`\nTech stack hint: ${input.stackHint}`);
  }

  parts.push(`\nRespond with ONLY valid JSON matching this schema:
{
  "parent": { "title": "string", "description": "string" },
  "children": [
    { "title": "string", "description": "string", "blocked_by": [/* indices of children this depends on */] }
  ]
}

No markdown fences, no explanation outside the JSON.

--- Request ---
${input.prompt}
--- End Request ---`);

  return parts.join("\n");
}

/**
 * Parse the LLM's JSON response into a DecompositionLLMResult.
 */
export function parseDecompositionResponse(response: string, maxSubIssues: number): DecompositionLLMResult {
  let cleaned = response.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
  }

  const raw = JSON.parse(cleaned);

  if (!raw.parent || typeof raw.parent.title !== "string" || typeof raw.parent.description !== "string") {
    throw new Error("Decomposition response missing valid 'parent' with title and description");
  }

  if (!Array.isArray(raw.children) || raw.children.length === 0) {
    throw new Error("Decomposition response must have at least one child");
  }

  if (raw.children.length > maxSubIssues) {
    raw.children = raw.children.slice(0, maxSubIssues);
  }

  for (let i = 0; i < raw.children.length; i++) {
    const child = raw.children[i];
    if (typeof child.title !== "string" || typeof child.description !== "string") {
      throw new Error(`Child at index ${i} missing title or description`);
    }
    if (!Array.isArray(child.blocked_by)) {
      child.blocked_by = [];
    }
    child.blocked_by = child.blocked_by.filter(
      (idx: unknown) => typeof idx === "number" && idx >= 0 && idx < raw.children.length && idx !== i,
    );
  }

  return raw as DecompositionLLMResult;
}

/**
 * Decompose a prompt into Linear sub-issue tree.
 *
 * 1. Send prompt to LLM for decomposition
 * 2. Create parent issue on Linear
 * 3. Create each child as a sub-issue
 * 4. Set blocking relations
 * 5. Return parent identifier
 */
export async function decomposeToIssues(
  input: DecomposeInput,
  issueCreator: IssueCreator,
  llmCall: LLMCallFn,
  config: Pick<ForgectlConfig, "planner">,
): Promise<DecomposeResult> {
  const model = config.planner.decomposition_model;
  const maxSubIssues = config.planner.max_sub_issues;

  const prompt = buildDecompositionPrompt(input, maxSubIssues);
  const response = await llmCall(prompt, model);
  const decomposition = parseDecompositionResponse(response, maxSubIssues);

  const parentIdentifier = await issueCreator.createIssue(
    decomposition.parent.title,
    decomposition.parent.description,
  );

  const childIdentifiers: string[] = [];
  const childIds: string[] = [];

  for (const child of decomposition.children) {
    const childId = await issueCreator.createSubIssue(
      child.title,
      child.description,
      parentIdentifier,
    );
    childIds.push(childId);
    childIdentifiers.push(childId);
  }

  for (let i = 0; i < decomposition.children.length; i++) {
    const child = decomposition.children[i];
    for (const depIdx of child.blocked_by) {
      await issueCreator.createBlockingRelation(childIds[depIdx], childIds[i]);
    }
  }

  return { parentIdentifier, childIdentifiers };
}
