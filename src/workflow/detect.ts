import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ValidationStep } from "../config/schema.js";

export interface StackDetection {
  stack: string;
  image: string;
  defaultValidation: ValidationStep[];
}

const STACK_MARKERS: {
  file: string;
  alt?: string;
  stack: string;
  image: string;
  validation: ValidationStep[];
}[] = [
  {
    file: "pyproject.toml",
    alt: "requirements.txt",
    stack: "python",
    image: "forgectl/code-python312",
    validation: [
      { name: "lint", command: "ruff check .", retries: 3, description: "Code style and quality checks" },
      { name: "typecheck", command: "mypy .", retries: 2, description: "Type checking" },
      { name: "test", command: "pytest", retries: 3, description: "Unit and integration tests" },
    ],
  },
  {
    file: "go.mod",
    stack: "go",
    image: "forgectl/code-go122",
    validation: [
      { name: "lint", command: "golangci-lint run", retries: 3, description: "Code style and quality checks" },
      { name: "test", command: "go test ./...", retries: 3, description: "Unit and integration tests" },
    ],
  },
  {
    file: "Cargo.toml",
    stack: "rust",
    image: "forgectl/code-rust",
    validation: [
      { name: "lint", command: "cargo clippy -- -D warnings", retries: 3, description: "Code style and quality checks" },
      { name: "test", command: "cargo test", retries: 3, description: "Unit and integration tests" },
    ],
  },
  {
    file: "package.json",
    stack: "node",
    image: "forgectl/code-node20",
    validation: [
      { name: "lint", command: "npm run lint", retries: 3, description: "Code style and quality checks" },
      { name: "typecheck", command: "npm run typecheck", retries: 2, description: "TypeScript type checking" },
      { name: "test", command: "npm test", retries: 3, description: "Unit and integration tests" },
      { name: "build", command: "npm run build", retries: 1, description: "Production build" },
    ],
  },
];

const DEFAULT_DETECTION: StackDetection = {
  stack: "node",
  image: "forgectl/code-node20",
  defaultValidation: [
    { name: "lint", command: "npm run lint", retries: 3, description: "Code style and quality checks" },
    { name: "typecheck", command: "npm run typecheck", retries: 2, description: "TypeScript type checking" },
    { name: "test", command: "npm test", retries: 3, description: "Unit and integration tests" },
    { name: "build", command: "npm run build", retries: 1, description: "Production build" },
  ],
};

export function detectStack(workspacePath: string): StackDetection {
  for (const marker of STACK_MARKERS) {
    if (
      existsSync(resolve(workspacePath, marker.file)) ||
      (marker.alt && existsSync(resolve(workspacePath, marker.alt)))
    ) {
      return {
        stack: marker.stack,
        image: marker.image,
        defaultValidation: marker.validation,
      };
    }
  }
  return DEFAULT_DETECTION;
}
