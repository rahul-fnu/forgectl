import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectStackFromDir, buildProfileYaml, type StackDetectionResult } from "../../src/config/auto-profile.js";

describe("detectStackFromDir", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forgectl-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects TypeScript from package.json + tsconfig.json", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: { build: "tsc", test: "vitest", lint: "eslint .", typecheck: "tsc --noEmit" },
      }),
    );
    writeFileSync(join(dir, "tsconfig.json"), "{}");

    const result = detectStackFromDir(dir);
    expect(result).not.toBeNull();
    expect(result!.stack).toBe("typescript");
    expect(result!.image).toBe("forgectl/code:latest");
    expect(result!.validationSteps).toEqual([
      { name: "build", command: "npm run build" },
      { name: "lint", command: "npm run lint" },
      { name: "typecheck", command: "npm run typecheck" },
      { name: "test", command: "npm test" },
    ]);
  });

  it("detects Node (no tsconfig)", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "jest" } }),
    );

    const result = detectStackFromDir(dir);
    expect(result).not.toBeNull();
    expect(result!.stack).toBe("node");
    expect(result!.validationSteps).toEqual([{ name: "test", command: "npm test" }]);
  });

  it("detects Python from pyproject.toml", () => {
    writeFileSync(
      join(dir, "pyproject.toml"),
      `[project]\ndependencies = [\n  "pytest>=7.0",\n  "ruff",\n  "mypy"\n]\n`,
    );

    const result = detectStackFromDir(dir);
    expect(result).not.toBeNull();
    expect(result!.stack).toBe("python");
    expect(result!.image).toBe("forgectl/code-python312:latest");
    expect(result!.validationSteps).toEqual([
      { name: "lint", command: "ruff check ." },
      { name: "typecheck", command: "mypy ." },
      { name: "test", command: "pytest" },
    ]);
  });

  it("detects Python from requirements.txt", () => {
    writeFileSync(join(dir, "requirements.txt"), "pytest>=7.0\nrequests\n");

    const result = detectStackFromDir(dir);
    expect(result).not.toBeNull();
    expect(result!.stack).toBe("python");
    expect(result!.validationSteps).toEqual([{ name: "test", command: "pytest" }]);
  });

  it("detects Go from go.mod", () => {
    writeFileSync(join(dir, "go.mod"), "module example.com/mymod\n\ngo 1.21\n");

    const result = detectStackFromDir(dir);
    expect(result).not.toBeNull();
    expect(result!.stack).toBe("go");
    expect(result!.image).toBe("forgectl/code-go:latest");
    expect(result!.validationSteps).toEqual([{ name: "test", command: "go test ./..." }]);
  });

  it("detects Go with golangci-lint config", () => {
    writeFileSync(join(dir, "go.mod"), "module example.com/mymod\n\ngo 1.21\n");
    writeFileSync(join(dir, ".golangci.yml"), "linters:\n  enable:\n    - gosec\n");

    const result = detectStackFromDir(dir);
    expect(result).not.toBeNull();
    expect(result!.stack).toBe("go");
    expect(result!.validationSteps).toEqual([
      { name: "lint", command: "golangci-lint run" },
      { name: "test", command: "go test ./..." },
    ]);
  });

  it("detects Rust from Cargo.toml", () => {
    writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "mylib"\nversion = "0.1.0"\n');

    const result = detectStackFromDir(dir);
    expect(result).not.toBeNull();
    expect(result!.stack).toBe("rust");
    expect(result!.image).toBe("forgectl/code-rust:latest");
    expect(result!.validationSteps).toEqual([
      { name: "clippy", command: "cargo clippy -- -D warnings" },
      { name: "test", command: "cargo test" },
    ]);
  });

  it("returns null for empty directory", () => {
    const result = detectStackFromDir(dir);
    expect(result).toBeNull();
  });

  it("picks first detected stack when multiple present (Node wins over Python)", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    writeFileSync(join(dir, "requirements.txt"), "pytest\n");

    const result = detectStackFromDir(dir);
    expect(result).not.toBeNull();
    expect(result!.stack).toBe("node");
  });
});

describe("buildProfileYaml", () => {
  it("generates valid profile YAML", () => {
    const detection: StackDetectionResult = {
      stack: "typescript",
      image: "forgectl/code:latest",
      validationSteps: [
        { name: "build", command: "npm run build" },
        { name: "test", command: "npm test" },
      ],
    };

    const yamlStr = buildProfileYaml("owner/myrepo", detection);

    expect(yamlStr).toContain("owner/myrepo");
    expect(yamlStr).toContain("forgectl/code:latest");
    expect(yamlStr).toContain("git clone");
    expect(yamlStr).toContain("git checkout main && git pull");
    expect(yamlStr).toContain("npm run build");
    expect(yamlStr).toContain("npm test");
  });

  it("omits validation when no steps detected", () => {
    const detection: StackDetectionResult = {
      stack: "go",
      image: "forgectl/code-go:latest",
      validationSteps: [],
    };

    const yamlStr = buildProfileYaml("owner/goapp", detection);

    expect(yamlStr).not.toContain("validation");
    expect(yamlStr).toContain("owner/goapp");
  });
});
