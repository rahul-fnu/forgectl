import type { WorkflowDefinition } from "../../config/schema.js";

export const browserResearchWorkflow: WorkflowDefinition = {
  name: "browser-research",
  description: "AI-driven browser research using browser-use for competitive analysis and data gathering",
  container: {
    image: "forgectl/research-browser",
    network: { mode: "open", allow: [] },
  },
  input: { mode: "files", mountPath: "/input" },
  tools: ["browser-use", "python3", "curl", "jq"],
  system: `You are an AI research agent with autonomous browser capabilities via browser-use.

You can browse the web autonomously to gather information, take screenshots, and extract data.
Context files (if any) are in /input.
Write your output to /output.

Rules:
- Produce a markdown report at /output/report.md
- Save structured data as /output/data.json when applicable
- Screenshots are saved automatically to /output/screenshots/
- Cite all sources with full URLs
- Distinguish facts from analysis/opinion
- Include an executive summary at the top of the report
- Use markdown formatting with proper headings and structure`,
  validation: {
    steps: [
      { name: "report-exists", command: "test -f /output/report.md", retries: 2, description: "Research report exists" },
      { name: "has-content", command: "wc -w /output/report.md | awk '{if($1<200) exit 1}'", retries: 1, description: "Report has at least 200 words" },
      { name: "has-sources", command: "grep -c 'http' /output/report.md | awk '{if($1<2) exit 1}'", retries: 1, description: "Report cites at least 2 URLs" },
    ],
    lint_steps: [],
    on_failure: "output-wip",
  },
  output: { mode: "files", path: "/output", collect: ["**/*.md", "**/*.json", "**/*.png", "**/*.jpg"] },
  review: {
    enabled: true,
    system: `You are a fact-checker and editor. Review this browser-based research report.
Check for: unsupported claims, missing citations, logical gaps, factual errors.
Verify that sources are cited with URLs and claims are supported.
If acceptable, respond with: APPROVED
If issues exist, list them numbered.`,
  },
  cache: { enabled: true, ttl: "7d" },
  autonomy: "full",
  skills: [],
};
