import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

export function scaffoldPython(dir: string, name: string): void {
  const srcDir = join(dir, "src", name);
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });

  writeFileSync(
    join(dir, "pyproject.toml"),
    `[project]
name = "${name}"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn>=0.34.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "ruff>=0.8.0",
    "mypy>=1.13.0",
]

[build-system]
requires = ["setuptools>=75.0"]
build-backend = "setuptools.backends._legacy:_Backend"
`,
  );

  writeFileSync(join(srcDir, "__init__.py"), "");

  writeFileSync(
    join(srcDir, "main.py"),
    `from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def read_root():
    return {"message": "Hello, world!"}
`,
  );

  writeFileSync(
    join(dir, "tests", "test_main.py"),
    `from fastapi.testclient import TestClient

from ${name}.main import app

client = TestClient(app)


def test_read_root():
    response = client.get("/")
    assert response.status_code == 200
    assert response.json() == {"message": "Hello, world!"}
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
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install -e ".[dev]"
      - run: ruff check .
      - run: mypy src/
      - run: pytest
`,
  );

  writeFileSync(
    join(dir, "Dockerfile"),
    `FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml .
RUN pip install --no-cache-dir .
COPY . .
CMD ["uvicorn", "${name}.main:app", "--host", "0.0.0.0", "--port", "8000"]
`,
  );

  writeFileSync(
    join(dir, "README.md"),
    `# ${name}

## Development

\`\`\`bash
pip install -e ".[dev]"
pytest
ruff check .
mypy src/
\`\`\`
`,
  );

  writeFileSync(
    join(dir, ".gitignore"),
    `__pycache__/
*.pyc
*.egg-info/
dist/
.venv/
.mypy_cache/
.ruff_cache/
.pytest_cache/
`,
  );
}
