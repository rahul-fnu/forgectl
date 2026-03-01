import type { WorkflowDefinition } from "../../config/schema.js";

export const generalWorkflow: WorkflowDefinition = {
  name: "general",
  description: "General-purpose workflow. Configure via project config.",
  container: {
    image: "forgectl/code-node20",
    network: { mode: "open", allow: [] },
  },
  input: { mode: "files", mountPath: "/input" },
  tools: ["git", "curl", "jq", "python3"],
  system: `You are an AI assistant working in an isolated container.
Input files (if any) are in /input. Write output to /output.
Complete the task as instructed.`,
  validation: { steps: [], on_failure: "output-wip" },
  output: { mode: "files", path: "/output", collect: ["**/*"] },
  review: { enabled: false, system: "" },
};
