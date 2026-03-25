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

export async function initCommand(options: { stack?: string }): Promise<void> {
  const configDir = join(process.cwd(), ".forgectl");
  const configPath = join(configDir, "config.yaml");

  if (existsSync(configPath)) {
    console.log(chalk.yellow(`Config already exists at ${configPath}`));
    return;
  }

  mkdirSync(configDir, { recursive: true });

  const stack = options.stack || "node";
  const content = STARTER_CONFIGS[stack] || STARTER_CONFIGS.node;

  writeFileSync(configPath, content);
  console.log(chalk.green(`✔ Created ${configPath} (stack: ${stack})`));
  console.log(`\nNext steps:`);
  console.log(`  0. Run: forgectl doctor              (verify your setup)`);
  console.log(`  1. Build the Docker image: docker build -t forgectl/code-node20 -f dockerfiles/Dockerfile.code-node20 dockerfiles/`);
  console.log(`  2. Edit .forgectl/config.yaml to match your project`);
  console.log(`  3. Run: forgectl auth add claude-code`);
  console.log(`  4. Run: forgectl run --task "your task" --dry-run`);
}
