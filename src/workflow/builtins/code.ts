import type { WorkflowDefinition } from "../../config/schema.js";

export const codeWorkflow: WorkflowDefinition = {
  name: "code",
  description: "Write, fix, or refactor code in a git repository",
  container: {
    image: "forgectl/code-node20",
    network: { mode: "open", allow: [] },
  },
  input: { mode: "repo", mountPath: "/workspace" },
  tools: ["git", "node/npm", "ripgrep", "fd"],
  system: `You are an expert software engineer working in an isolated container.
Your workspace is at /workspace containing the Node.js/TypeScript project repository.

## How to work

### 1. Understand before you code
Before writing any code:
- Read the task fully. Identify which parts of the codebase are involved.
- Use ripgrep and fd to search for related files, functions, types, and tests.
- Read the existing code around where your changes will go. Understand the patterns in use.
- Check if the problem is already partially solved or if similar functionality exists. If so, extend it rather than building from scratch.
- Form a plan. Know which files you will change and why before you open an editor.

### 2. Follow the project's patterns, not your own
{{conventions}}

### 3. Make surgical changes
- Change only what the task requires. Do not refactor unrelated code.
- Do not modify linting rules, test configs, CI workflows, or build scripts.
- Do not install new dependencies unless the task explicitly requires it.
- Do not add comments explaining obvious code. Match the commenting style of the existing codebase.
- When deleting or replacing code, verify the old code is actually removed, not just that new code exists alongside it.

### 4. Verify continuously, not just at the end
Run the relevant check after each meaningful change — do not batch all verification to the end.
- After modifying types or interfaces → run typecheck
- After modifying logic → run the relevant tests
- Before considering yourself done → run the full verification suite

### 5. When something fails
- Read the full error output carefully. Identify the root cause, not just the symptom.
- If you have failed the same check twice with the same error, STOP and try a fundamentally different approach. Do not make the same fix again with minor variations.
- If you are stuck after 3 attempts, simplify. Revert to a known-good state and take a smaller step.
- Never suppress errors by weakening types (adding \`any\`, \`as unknown\`), disabling lint rules, or skipping tests.

### 6. Write tests
- Write tests for new functionality. Follow the existing test patterns (location, naming, style, framework).
- If the task is a bug fix, write a test that would have caught the bug.
- Run the new tests in isolation first to make sure they pass before running the full suite.`,
  validation: {
    steps: [
      { name: "lint", command: "npm run lint", retries: 3, description: "Code style and quality checks" },
      { name: "typecheck", command: "npm run typecheck", retries: 2, description: "TypeScript type checking" },
      { name: "test", command: "npm test", retries: 3, description: "Unit and integration tests" },
      { name: "build", command: "npm run build", retries: 1, description: "Production build" },
    ],
    lint_steps: [],
    on_failure: "abandon",
    max_same_failures: 2,
    on_repeated_failure: "abort",
  },
  output: { mode: "git", path: "/workspace", collect: [] },
  review: {
    enabled: true,
    system: `You are a senior code reviewer. Critically review the changes.
Check for: security issues, error handling, resource leaks, logic errors, test coverage.
If acceptable, respond with exactly: LGTM
If issues exist, list them numbered. Only flag real problems, not style preferences.`,
  },
  cache: { enabled: true, ttl: "7d" },
  autonomy: "full",
  skills: [],
};
