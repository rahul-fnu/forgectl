import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

export function scaffoldNode(dir: string, name: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        type: "module",
        scripts: {
          build: "tsc",
          typecheck: "tsc --noEmit",
          test: "vitest run",
          lint: "eslint src/",
        },
        devDependencies: {
          typescript: "^5.7.0",
          vitest: "^3.0.0",
          eslint: "^9.0.0",
        },
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          outDir: "dist",
          rootDir: "src",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          declaration: true,
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    join(dir, "src", "index.ts"),
    `export function hello(): string {
  return "Hello, world!";
}

console.log(hello());
`,
  );

  writeFileSync(
    join(dir, "test", "index.test.ts"),
    `import { describe, it, expect } from "vitest";
import { hello } from "../src/index.js";

describe("hello", () => {
  it("returns greeting", () => {
    expect(hello()).toBe("Hello, world!");
  });
});
`,
  );

  writeFileSync(
    join(dir, ".github", "workflows", "ci.yml"),
    `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
`,
  );

  writeFileSync(
    join(dir, ".gitignore"),
    `node_modules/
dist/
*.log
.env
coverage/
`,
  );
}
