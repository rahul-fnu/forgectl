import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { detectStack, projectListCommand, projectShowCommand } from "../../src/cli/project.js";

const TEST_DIR = join(process.cwd(), "test-tmp-project-detect");

describe("project CLI", () => {
  describe("detectStack", () => {
    beforeEach(() => {
      mkdirSync(TEST_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it("detects TypeScript/Node.js project", () => {
      writeFileSync(
        join(TEST_DIR, "package.json"),
        JSON.stringify({
          scripts: { test: "vitest", lint: "eslint .", build: "tsc" },
          devDependencies: { typescript: "^5.0.0" },
        }),
      );
      writeFileSync(join(TEST_DIR, "tsconfig.json"), "{}");

      const stack = detectStack(TEST_DIR);
      expect(stack.language).toBe("TypeScript");
      expect(stack.tools).toContain("typescript");
      expect(stack.tools).toContain("eslint");
      expect(stack.image).toBe("forgectl/code-node20");
      expect(stack.validation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "test", command: "npm test" }),
          expect.objectContaining({ name: "lint", command: "npm run lint" }),
          expect.objectContaining({ name: "build", command: "npm run build" }),
        ]),
      );
    });

    it("detects plain Node.js project (no TypeScript)", () => {
      writeFileSync(
        join(TEST_DIR, "package.json"),
        JSON.stringify({ scripts: { test: "jest" } }),
      );

      const stack = detectStack(TEST_DIR);
      expect(stack.language).toBe("Node.js");
      expect(stack.tools).not.toContain("typescript");
      expect(stack.image).toBe("forgectl/code-node20");
    });

    it("detects Python project with pytest, ruff, mypy", () => {
      writeFileSync(
        join(TEST_DIR, "pyproject.toml"),
        `[tool.pytest]\n[tool.ruff]\n[tool.mypy]\n`,
      );

      const stack = detectStack(TEST_DIR);
      expect(stack.language).toBe("Python");
      expect(stack.tools).toContain("pytest");
      expect(stack.tools).toContain("ruff");
      expect(stack.tools).toContain("mypy");
      expect(stack.image).toBe("forgectl/code-python312");
      expect(stack.validation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "test", command: "pytest" }),
          expect.objectContaining({ name: "lint", command: "ruff check ." }),
          expect.objectContaining({ name: "typecheck", command: "mypy ." }),
        ]),
      );
    });

    it("detects Python project from requirements.txt", () => {
      writeFileSync(join(TEST_DIR, "requirements.txt"), "pytest\nflake8\n");

      const stack = detectStack(TEST_DIR);
      expect(stack.language).toBe("Python");
      expect(stack.tools).toContain("pytest");
      expect(stack.tools).toContain("flake8");
    });

    it("detects Go project", () => {
      writeFileSync(join(TEST_DIR, "go.mod"), "module example.com/foo\n");

      const stack = detectStack(TEST_DIR);
      expect(stack.language).toBe("Go");
      expect(stack.image).toBe("forgectl/code-go122");
      expect(stack.validation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "test", command: "go test ./..." }),
        ]),
      );
    });

    it("detects Go project with golangci-lint", () => {
      writeFileSync(join(TEST_DIR, "go.mod"), "module example.com/foo\n");
      writeFileSync(join(TEST_DIR, ".golangci.yml"), "linters:\n");

      const stack = detectStack(TEST_DIR);
      expect(stack.language).toBe("Go");
      expect(stack.tools).toContain("golangci-lint");
      expect(stack.validation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "lint", command: "golangci-lint run" }),
        ]),
      );
    });

    it("detects Rust project", () => {
      writeFileSync(join(TEST_DIR, "Cargo.toml"), '[package]\nname = "foo"\n');

      const stack = detectStack(TEST_DIR);
      expect(stack.language).toBe("Rust");
      expect(stack.image).toBe("forgectl/code-rust");
      expect(stack.validation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "test", command: "cargo test" }),
          expect.objectContaining({ name: "lint", command: "cargo clippy -- -D warnings" }),
        ]),
      );
    });

    it("returns Unknown for unrecognized project", () => {
      writeFileSync(join(TEST_DIR, "README.md"), "# Hello\n");

      const stack = detectStack(TEST_DIR);
      expect(stack.language).toBe("Unknown");
      expect(stack.tools).toEqual([]);
      expect(stack.validation).toEqual([]);
    });
  });

  describe("projectListCommand", () => {
    const TEST_HOME = join(process.cwd(), "test-tmp-project-list");

    beforeEach(() => {
      mkdirSync(join(TEST_HOME, ".forgectl", "repos"), { recursive: true });
      vi.stubEnv("HOME", TEST_HOME);
    });

    afterEach(() => {
      rmSync(TEST_HOME, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });

    it("shows message when no projects configured", async () => {
      rmSync(join(TEST_HOME, ".forgectl", "repos"), { recursive: true, force: true });
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      await projectListCommand();
      expect(spy).toHaveBeenCalledWith("No projects configured.");
      spy.mockRestore();
    });

    it("lists projects with repo info", async () => {
      const yaml = await import("js-yaml");
      writeFileSync(
        join(TEST_HOME, ".forgectl", "repos", "myapp.yaml"),
        yaml.default.dump({
          tracker: { kind: "github", repo: "org/myapp", token: "$gh" },
          container: { image: "forgectl/code-node20" },
        }),
      );

      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      await projectListCommand();
      const output = spy.mock.calls.map(c => c[0]).join("\n");
      expect(output).toContain("myapp");
      expect(output).toContain("org/myapp");
      spy.mockRestore();
    });
  });
});
