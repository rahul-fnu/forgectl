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
Your workspace is at /workspace containing the full project repository.

Rules:
- Make the minimal changes needed to complete the task
- Write tests for any new functionality
- Follow existing code style and conventions
- Do not modify linting rules, test configs, or build scripts
- Do not install new dependencies unless the task requires it`,
  validation: {
    steps: [
      { name: "lint", command: "npm run lint", retries: 3, description: "Code style and quality checks" },
      { name: "typecheck", command: "npm run typecheck", retries: 2, description: "TypeScript type checking" },
      { name: "test", command: "npm test", retries: 3, description: "Unit and integration tests" },
      { name: "build", command: "npm run build", retries: 1, description: "Production build" },
    ],
    on_failure: "abandon",
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
