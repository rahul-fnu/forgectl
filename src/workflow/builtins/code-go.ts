import type { WorkflowDefinition } from "../../config/schema.js";

export const codeGoWorkflow: WorkflowDefinition = {
  name: "code-go",
  description: "Write, fix, or refactor Go code in a git repository",
  container: {
    image: "forgectl/code-go122",
    network: { mode: "open", allow: [] },
  },
  input: { mode: "repo", mountPath: "/workspace" },
  tools: ["git", "go", "golangci-lint", "gopls", "dlv", "ripgrep", "fd"],
  system: `You are an expert Go software engineer working in an isolated container.
Your workspace is at /workspace containing the full project repository.
Go 1.22, golangci-lint, gopls, and delve are pre-installed.

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
      { name: "lint", command: "golangci-lint run", retries: 3, description: "Code style and quality checks" },
      { name: "test", command: "go test ./...", retries: 3, description: "Unit and integration tests" },
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
