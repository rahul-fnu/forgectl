import type { WorkflowDefinition } from "../../config/schema.js";

export const codePythonWorkflow: WorkflowDefinition = {
  name: "code-python",
  description: "Write, fix, or refactor Python code in a git repository",
  container: {
    image: "forgectl/code-python312",
    network: { mode: "open", allow: [] },
  },
  input: { mode: "repo", mountPath: "/workspace" },
  tools: ["git", "python/pip", "poetry", "pytest", "ruff", "mypy", "ripgrep", "fd"],
  system: `You are an expert Python software engineer working in an isolated container.
Your workspace is at /workspace containing the full project repository.
Python 3.12, poetry, pytest, ruff, mypy, and pyright are pre-installed.

Rules:
- Before implementing, search the codebase for existing solutions to the same problem. Reuse existing logic instead of reimplementing.
- Make the minimal changes needed to complete the task
- Write tests for any new functionality
- Follow existing code style and conventions
- Do not modify linting rules, test configs, or build scripts
- Do not install new dependencies unless the task requires it
- When consolidating or refactoring, verify the old code is actually deleted, not just that new code exists`,
  validation: {
    steps: [
      { name: "lint", command: "ruff check .", retries: 3, description: "Code style and quality checks" },
      { name: "typecheck", command: "mypy .", retries: 2, description: "Type checking" },
      { name: "test", command: "pytest", retries: 3, description: "Unit and integration tests" },
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
