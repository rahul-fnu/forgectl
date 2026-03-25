import type { WorkflowDefinition } from "../../config/schema.js";

export const researchWorkflow: WorkflowDefinition = {
  name: "research",
  description: "Research a topic, synthesize findings, produce a report",
  container: {
    image: "forgectl/research-browser",
    network: { mode: "open", allow: [] },
  },
  input: { mode: "files", mountPath: "/input" },
  tools: ["curl", "puppeteer", "jq", "pandoc", "python3"],
  system: `You are an expert researcher working in an isolated container.

You have access to the web via curl and a headless browser (Puppeteer).
Context files (if any) are in /input.
Write your output to /output.

Rules:
- Cite all sources with URLs
- Distinguish facts from analysis/opinion
- Use markdown for reports
- Include an executive summary at the top
- Save all output files to /output`,
  validation: {
    steps: [
      { name: "output-exists", command: "test -f /output/*.md || test -f /output/*.pdf", retries: 2, description: "Report file exists" },
      { name: "has-sources", command: "grep -c 'http' /output/*.md | awk -F: '{s+=$2} END {if(s<3) exit 1}'", retries: 2, description: "Report includes at least 3 source URLs" },
      { name: "min-length", command: "wc -w /output/*.md | tail -1 | awk '{if($1<500) exit 1}'", retries: 1, description: "Report is at least 500 words" },
    ],
    lint_steps: [],
    on_failure: "output-wip",
    max_same_failures: 2,
    on_repeated_failure: "abort",
  },
  output: { mode: "files", path: "/output", collect: ["**/*.md", "**/*.pdf", "**/*.json"] },
  review: {
    enabled: true,
    system: `You are a fact-checker and editor. Review this research report.
Check for: unsupported claims, missing citations, logical gaps, outdated information.
If acceptable, respond with: APPROVED
If issues exist, list them numbered.`,
  },
  cache: { enabled: true, ttl: "7d" },
  autonomy: "full",
  skills: [],
};
