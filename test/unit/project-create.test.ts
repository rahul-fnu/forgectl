import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldProject, createGitHubRepo, type CreateProjectOptions } from "../../src/project/create.js";

describe("scaffoldProject", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forgectl-scaffold-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("python", () => {
    const opts: CreateProjectOptions = { name: "myapp", stack: "python" };

    it("generates pyproject.toml with correct name and deps", () => {
      scaffoldProject(dir, opts);
      const content = readFileSync(join(dir, "pyproject.toml"), "utf-8");
      expect(content).toContain('name = "myapp"');
      expect(content).toContain("fastapi");
      expect(content).toContain("uvicorn");
      expect(content).toContain("pytest");
      expect(content).toContain("ruff");
      expect(content).toContain("mypy");
      expect(content).toContain('requires-python = ">=3.12"');
    });

    it("generates source files", () => {
      scaffoldProject(dir, opts);
      expect(existsSync(join(dir, "src", "myapp", "__init__.py"))).toBe(true);
      expect(existsSync(join(dir, "src", "myapp", "main.py"))).toBe(true);
      const main = readFileSync(join(dir, "src", "myapp", "main.py"), "utf-8");
      expect(main).toContain("FastAPI");
      expect(main).toContain("Hello, world!");
    });

    it("generates test file", () => {
      scaffoldProject(dir, opts);
      const test = readFileSync(join(dir, "tests", "test_main.py"), "utf-8");
      expect(test).toContain("test_read_root");
      expect(test).toContain("myapp.main");
    });

    it("generates CI workflow", () => {
      scaffoldProject(dir, opts);
      const ci = readFileSync(join(dir, ".github", "workflows", "ci.yml"), "utf-8");
      expect(ci).toContain("pytest");
      expect(ci).toContain("ruff");
      expect(ci).toContain("mypy");
    });

    it("generates Dockerfile", () => {
      scaffoldProject(dir, opts);
      const df = readFileSync(join(dir, "Dockerfile"), "utf-8");
      expect(df).toContain("python:3.12");
      expect(df).toContain("uvicorn");
    });

    it("generates README and .gitignore", () => {
      scaffoldProject(dir, opts);
      expect(existsSync(join(dir, "README.md"))).toBe(true);
      expect(existsSync(join(dir, ".gitignore"))).toBe(true);
      const gi = readFileSync(join(dir, ".gitignore"), "utf-8");
      expect(gi).toContain("__pycache__");
    });
  });

  describe("node/typescript", () => {
    const opts: CreateProjectOptions = { name: "mylib", stack: "typescript" };

    it("generates package.json with correct name and deps", () => {
      scaffoldProject(dir, opts);
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      expect(pkg.name).toBe("mylib");
      expect(pkg.devDependencies.typescript).toBeDefined();
      expect(pkg.devDependencies.vitest).toBeDefined();
      expect(pkg.devDependencies.eslint).toBeDefined();
      expect(pkg.scripts.build).toBe("tsc");
      expect(pkg.scripts.typecheck).toBe("tsc --noEmit");
      expect(pkg.scripts.test).toBe("vitest run");
    });

    it("generates tsconfig.json", () => {
      scaffoldProject(dir, opts);
      const tsconfig = JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf-8"));
      expect(tsconfig.compilerOptions.strict).toBe(true);
    });

    it("generates source and test files", () => {
      scaffoldProject(dir, opts);
      const src = readFileSync(join(dir, "src", "index.ts"), "utf-8");
      expect(src).toContain("Hello, world!");
      const test = readFileSync(join(dir, "test", "index.test.ts"), "utf-8");
      expect(test).toContain("hello");
    });

    it("generates CI workflow", () => {
      scaffoldProject(dir, opts);
      const ci = readFileSync(join(dir, ".github", "workflows", "ci.yml"), "utf-8");
      expect(ci).toContain("typecheck");
      expect(ci).toContain("npm test");
      expect(ci).toContain("npm run build");
    });

    it("generates .gitignore", () => {
      scaffoldProject(dir, opts);
      const gi = readFileSync(join(dir, ".gitignore"), "utf-8");
      expect(gi).toContain("node_modules");
      expect(gi).toContain("dist");
    });

    it("works with 'node' stack too", () => {
      scaffoldProject(dir, { name: "jsapp", stack: "node" });
      expect(existsSync(join(dir, "package.json"))).toBe(true);
      expect(existsSync(join(dir, "tsconfig.json"))).toBe(true);
    });
  });

  describe("go", () => {
    const opts: CreateProjectOptions = { name: "myservice", stack: "go", org: "myorg" };

    it("generates go.mod with module path", () => {
      scaffoldProject(dir, opts);
      const mod = readFileSync(join(dir, "go.mod"), "utf-8");
      expect(mod).toContain("module github.com/myorg/myservice");
      expect(mod).toContain("go 1.22");
    });

    it("generates main.go with HTTP server", () => {
      scaffoldProject(dir, opts);
      const main = readFileSync(join(dir, "main.go"), "utf-8");
      expect(main).toContain("net/http");
      expect(main).toContain("Hello, world!");
    });

    it("generates test file", () => {
      scaffoldProject(dir, opts);
      const test = readFileSync(join(dir, "main_test.go"), "utf-8");
      expect(test).toContain("TestHelloHandler");
      expect(test).toContain("httptest");
    });

    it("generates CI workflow with golangci-lint", () => {
      scaffoldProject(dir, opts);
      const ci = readFileSync(join(dir, ".github", "workflows", "ci.yml"), "utf-8");
      expect(ci).toContain("go test");
      expect(ci).toContain("golangci-lint");
    });

    it("generates .gitignore", () => {
      scaffoldProject(dir, opts);
      expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    });
  });

  describe("rust", () => {
    const opts: CreateProjectOptions = { name: "mycrate", stack: "rust" };

    it("generates Cargo.toml", () => {
      scaffoldProject(dir, opts);
      const cargo = readFileSync(join(dir, "Cargo.toml"), "utf-8");
      expect(cargo).toContain('name = "mycrate"');
      expect(cargo).toContain('edition = "2021"');
    });

    it("generates src/main.rs and src/lib.rs", () => {
      scaffoldProject(dir, opts);
      expect(existsSync(join(dir, "src", "main.rs"))).toBe(true);
      const lib = readFileSync(join(dir, "src", "lib.rs"), "utf-8");
      expect(lib).toContain("Hello, world!");
      expect(lib).toContain("#[test]");
    });

    it("generates CI workflow with clippy", () => {
      scaffoldProject(dir, opts);
      const ci = readFileSync(join(dir, ".github", "workflows", "ci.yml"), "utf-8");
      expect(ci).toContain("cargo test");
      expect(ci).toContain("cargo clippy");
    });

    it("generates .gitignore", () => {
      scaffoldProject(dir, opts);
      const gi = readFileSync(join(dir, ".gitignore"), "utf-8");
      expect(gi).toContain("target/");
    });
  });
});

describe("createGitHubRepo", () => {
  it("calls createForAuthenticatedUser when no org", async () => {
    const createForAuthenticatedUser = vi.fn().mockResolvedValue({
      data: {
        full_name: "user/myapp",
        clone_url: "https://github.com/user/myapp.git",
        html_url: "https://github.com/user/myapp",
      },
    });

    const octokit = {
      rest: {
        repos: { createForAuthenticatedUser, createInOrg: vi.fn() },
      },
    } as any;

    const result = await createGitHubRepo(octokit, {
      name: "myapp",
      stack: "python",
      description: "My app",
      private: true,
    });

    expect(createForAuthenticatedUser).toHaveBeenCalledWith({
      name: "myapp",
      description: "My app",
      private: true,
      auto_init: false,
    });
    expect(result.repoSlug).toBe("user/myapp");
    expect(result.cloneUrl).toBe("https://github.com/user/myapp.git");
    expect(result.htmlUrl).toBe("https://github.com/user/myapp");
  });

  it("calls createInOrg when org is provided", async () => {
    const createInOrg = vi.fn().mockResolvedValue({
      data: {
        full_name: "myorg/myapp",
        clone_url: "https://github.com/myorg/myapp.git",
        html_url: "https://github.com/myorg/myapp",
      },
    });

    const octokit = {
      rest: {
        repos: { createForAuthenticatedUser: vi.fn(), createInOrg },
      },
    } as any;

    const result = await createGitHubRepo(octokit, {
      name: "myapp",
      stack: "typescript",
      org: "myorg",
    });

    expect(createInOrg).toHaveBeenCalledWith({
      org: "myorg",
      name: "myapp",
      description: "",
      private: true,
      auto_init: false,
    });
    expect(result.repoSlug).toBe("myorg/myapp");
  });

  it("defaults private to true and description to empty", async () => {
    const createForAuthenticatedUser = vi.fn().mockResolvedValue({
      data: { full_name: "u/x", clone_url: "https://x", html_url: "https://x" },
    });

    const octokit = {
      rest: { repos: { createForAuthenticatedUser, createInOrg: vi.fn() } },
    } as any;

    await createGitHubRepo(octokit, { name: "x", stack: "go" });

    expect(createForAuthenticatedUser).toHaveBeenCalledWith(
      expect.objectContaining({ private: true, description: "" }),
    );
  });
});
