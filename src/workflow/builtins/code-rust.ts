import type { WorkflowDefinition } from "../../config/schema.js";

export const codeRustWorkflow: WorkflowDefinition = {
  name: "code-rust",
  description: "Write, fix, or refactor Rust code in a git repository",
  container: {
    image: "forgectl/code-rust",
    network: { mode: "open", allow: [] },
  },
  input: { mode: "repo", mountPath: "/workspace" },
  tools: ["git", "cargo", "clippy", "rust-analyzer", "cargo-nextest", "ripgrep", "fd"],
  system: `You are an expert Rust software engineer working in an isolated container.
Your workspace is at /workspace containing the full project repository.
Rust stable, clippy, rust-analyzer, and cargo-nextest are pre-installed.

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
      { name: "lint", command: "cargo clippy -- -D warnings", retries: 3, description: "Code style and quality checks" },
      { name: "test", command: "cargo test", retries: 3, description: "Unit and integration tests" },
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
