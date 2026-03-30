interface ScaffoldOptions {
  id: string;
  title: string;
  files?: string[];
  constraints?: string[];
}

export function scaffoldTaskSpec(options: ScaffoldOptions): string {
  const files = options.files ?? ["src/**/*.ts"];
  const constraints = options.constraints ?? [];

  const constraintsBlock = constraints.length > 0
    ? `constraints:\n${constraints.map((c) => `  - "${c}"`).join("\n")}`
    : `constraints: []`;

  return `# Task Specification
# See docs for full schema reference

id: ${options.id}
title: "${options.title}"

context:
  files:
${files.map((f) => `    - "${f}"`).join("\n")}
  # TODO: Add relevant docs

${constraintsBlock}

acceptance:
  - run: "npm test"
    description: "TODO: Define acceptance criteria"

decomposition:
  strategy: auto

effort:
  max_turns: 50
  timeout: "30m"
`;
}
