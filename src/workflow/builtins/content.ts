import type { WorkflowDefinition } from "../../config/schema.js";

export const contentWorkflow: WorkflowDefinition = {
  name: "content",
  description: "Write blog posts, documentation, marketing copy, translations",
  container: {
    image: "forgectl/content",
    network: { mode: "open", allow: [] },
  },
  input: { mode: "files", mountPath: "/input" },
  tools: ["pandoc", "vale", "wkhtmltopdf", "python3"],
  system: `You are an expert writer working in an isolated container.

Context files (brand guides, source material, etc.) are in /input.
Write your output to /output.

Rules:
- Match the tone and style specified in the task or brand guide
- Use markdown unless another format is specified
- Include appropriate headings and structure
- Save all output files to /output`,
  validation: {
    steps: [
      { name: "output-exists", command: "ls /output/*.md /output/*.html /output/*.pdf 2>/dev/null | head -1 | grep -q .", retries: 2, description: "Output file exists" },
      { name: "prose-lint", command: "vale --output=line /output/*.md 2>/dev/null || true", retries: 2, description: "Prose quality check (spelling, grammar, style)" },
    ],
    lint_steps: [],
    on_failure: "output-wip",
  },
  output: { mode: "files", path: "/output", collect: ["**/*.md", "**/*.html", "**/*.pdf", "**/*.docx"] },
  review: {
    enabled: true,
    system: `You are a senior editor. Review this content for clarity, accuracy, and tone.
Check for: factual errors, unclear writing, tone inconsistency, missing sections.
If acceptable, respond with: APPROVED
If issues exist, list them numbered.`,
  },
  cache: { enabled: true, ttl: "7d" },
  autonomy: "full",
  skills: [],
};
