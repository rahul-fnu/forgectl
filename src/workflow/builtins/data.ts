import type { WorkflowDefinition } from "../../config/schema.js";

export const dataWorkflow: WorkflowDefinition = {
  name: "data",
  description: "ETL, analysis, cleaning, visualization, dataset transformation",
  container: {
    image: "forgectl/data",
    network: { mode: "open", allow: [] },
  },
  input: { mode: "files", mountPath: "/input" },
  tools: ["python3", "pandas", "numpy", "matplotlib", "duckdb", "jq", "csvkit"],
  system: `You are a data engineer/analyst working in an isolated container.

Input data files are in /input.
Write all output to /output.

Rules:
- Validate data before and after transformations
- Preserve original files in /input (read-only)
- Document any assumptions or data quality issues
- Save analysis scripts to /output/scripts/ so work is reproducible
- Save data outputs to /output/data/
- Save visualizations to /output/viz/`,
  validation: {
    steps: [
      { name: "output-exists", command: "ls /output/data/* 2>/dev/null | head -1 | grep -q .", retries: 2, description: "Output data files exist" },
      { name: "scripts-exist", command: "ls /output/scripts/*.py 2>/dev/null | head -1 | grep -q .", retries: 1, description: "Processing scripts are saved (reproducibility)" },
      {
        name: "no-pii",
        command: `python3 -c "
import re, sys, glob
patterns = [r'\\b\\d{3}-\\d{2}-\\d{4}\\b', r'\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b']
for f in glob.glob('/output/data/*'):
  text = open(f).read()
  for p in patterns:
    if re.search(p, text):
      print(f'PII detected in {f}'); sys.exit(1)
"`,
        retries: 1,
        description: "Check output for PII (SSN, email patterns)",
      },
    ],
    lint_steps: [],
    on_failure: "abandon",
  },
  output: { mode: "files", path: "/output", collect: ["**/*"] },
  review: { enabled: false, system: "" },
  cache: { enabled: true, ttl: "7d" },
  autonomy: "full",
  skills: [],
};
