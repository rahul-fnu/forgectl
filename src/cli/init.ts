import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";

const STARTER_CONFIGS: Record<string, string> = {
  node: `# forgectl config — Node.js project
agent:
  type: claude-code

container:
  resources:
    memory: 4g
    cpus: 2

validation:
  steps:
    - name: lint
      command: npm run lint
      retries: 3
    - name: test
      command: npm test
      retries: 3
    - name: build
      command: npm run build
      retries: 1
`,
  python: `# forgectl config — Python project
agent:
  type: claude-code

container:
  image: forgectl/code-python312
  resources:
    memory: 4g
    cpus: 2

validation:
  steps:
    - name: lint
      command: ruff check .
      retries: 3
    - name: typecheck
      command: mypy .
      retries: 2
    - name: test
      command: pytest
      retries: 3
`,
  go: `# forgectl config — Go project
agent:
  type: claude-code

container:
  image: forgectl/code-go122
  resources:
    memory: 4g
    cpus: 2

validation:
  steps:
    - name: lint
      command: golangci-lint run
      retries: 3
    - name: test
      command: go test ./...
      retries: 3
    - name: build
      command: go build ./...
      retries: 1
`,
  research: `# forgectl config — Research workflow
agent:
  type: claude-code

orchestration:
  mode: review

output:
  dir: ./research-output
`,
  data: `# forgectl config — Data workflow
agent:
  type: claude-code

output:
  dir: ./data-output
`,
  ops: `# forgectl config — Ops/Infrastructure workflow
agent:
  type: claude-code

validation:
  steps:
    - name: shellcheck
      command: find . -name '*.sh' -exec shellcheck {} +
      retries: 2
    - name: terraform-validate
      command: terraform validate
      retries: 2
`,
};

const VALID_STACKS = Object.keys(STARTER_CONFIGS);

export async function initCommand(options: { stack?: string }): Promise<void> {
  const configDir = join(process.cwd(), ".forgectl");
  const configPath = join(configDir, "config.yaml");

  if (existsSync(configPath)) {
    console.log(chalk.yellow(`Config already exists at ${configPath}`));
    console.log(chalk.gray(`  To regenerate, remove it first: rm ${configPath}`));
    return;
  }

  const stack = options.stack || "node";

  if (!STARTER_CONFIGS[stack]) {
    console.error(chalk.red(`Unknown stack: "${stack}"`));
    console.error(`Available stacks: ${VALID_STACKS.join(", ")}`);
    process.exit(1);
  }

  mkdirSync(configDir, { recursive: true });

  const content = STARTER_CONFIGS[stack];

  writeFileSync(configPath, content);
  console.log(chalk.green(`✔ Created ${configPath} (stack: ${stack})`));
  console.log(`\nNext steps:`);
  console.log(`  1. Run: forgectl doctor              (verify your setup)`);
  console.log(`  2. Edit .forgectl/config.yaml         (match your project)`);
  console.log(`  3. Run: forgectl auth add claude-code  (add your API key)`);
  console.log(`  4. Run: forgectl run --task "your task" --dry-run`);
}
