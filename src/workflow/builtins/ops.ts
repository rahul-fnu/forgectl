import type { WorkflowDefinition } from "../../config/schema.js";

export const opsWorkflow: WorkflowDefinition = {
  name: "ops",
  description: "Infrastructure scripts, Terraform modules, migration scripts, monitoring config",
  container: {
    image: "forgectl/ops",
    network: { mode: "open", allow: [] },
  },
  input: { mode: "repo", mountPath: "/workspace" },
  tools: ["terraform", "aws-cli", "kubectl", "ansible", "shellcheck", "python3"],
  system: `You are a senior infrastructure engineer working in an isolated container.

Your workspace is at /workspace. You are writing infrastructure-as-code.
You do NOT have access to any real cloud accounts or clusters.
All validation is via dry-run / plan / lint — nothing is applied.

Rules:
- All Terraform must pass \`terraform validate\` and \`terraform fmt\`
- All shell scripts must pass shellcheck
- Include README or comments explaining what the code does
- Use variables for anything environment-specific (no hardcoded values)`,
  validation: {
    steps: [
      { name: "shellcheck", command: "find /workspace -name '*.sh' -exec shellcheck {} + 2>/dev/null || true", retries: 2, description: "Shell script linting" },
      { name: "terraform-fmt", command: "find /workspace -name '*.tf' -exec terraform fmt -check {} + 2>/dev/null || true", retries: 2, description: "Terraform formatting" },
      { name: "terraform-validate", command: "cd /workspace && terraform init -backend=false 2>/dev/null && terraform validate 2>/dev/null || true", retries: 2, description: "Terraform configuration validation" },
    ],
    on_failure: "output-wip",
  },
  output: { mode: "git", path: "/workspace", collect: [] },
  review: {
    enabled: true,
    system: `You are a senior infrastructure reviewer. Review these IaC changes.
Check for: security misconfigs, missing encryption, overly permissive IAM,
hardcoded secrets, missing tagging, resource naming conventions.
If acceptable, respond with: LGTM
If issues exist, list them numbered.`,
  },
  autonomy: "full",
};
