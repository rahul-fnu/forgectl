import yaml from "js-yaml";
import type { ScaffoldOptions } from "./types.js";

/**
 * Generate a new task spec YAML file with helpful comments and defaults.
 */
export function scaffoldTaskSpec(options: ScaffoldOptions): string {
  const spec = {
    id: options.id,
    title: options.title,
    description: "TODO: Describe what this task should accomplish",
    context: {
      files: options.files && options.files.length > 0 ? options.files : ["src/**/*.ts"],
      docs: ["TODO: Add documentation references"],
      modules: [],
      related_tasks: [],
    },
    constraints: options.constraints && options.constraints.length > 0
      ? options.constraints
      : ["TODO: Add constraints (e.g. 'Do not modify public API')"],
    acceptance: [
      {
        run: "npm test",
        description: "TODO: All tests pass",
      },
      {
        description: "TODO: Add more acceptance criteria",
      },
    ],
    decomposition: {
      strategy: "auto",
      max_depth: 2,
    },
    effort: {
      max_turns: 50,
      max_review_rounds: 3,
      timeout: "30m",
    },
    metadata: {
      author: "TODO",
      priority: "medium",
    },
  };

  const header = `# Task Specification for forgectl
# See: https://github.com/anthropics/forgectl/docs/task-spec.md
#
# Fields:
#   id          — Unique lowercase identifier (letters, numbers, hyphens)
#   title       — Short human-readable title (max 200 chars)
#   description — Detailed description of what the task should accomplish
#   context     — Files, docs, and modules relevant to this task
#   constraints — Rules the agent must follow
#   acceptance  — Criteria that must be met for the task to be considered done
#   decomposition — How the task can be broken into subtasks
#   effort      — Limits on agent effort (turns, review rounds, timeout)
#   metadata    — Arbitrary key-value pairs for tracking
`;

  const yamlBody = yaml.dump(spec, {
    lineWidth: 100,
    quotingType: "\"",
    forceQuotes: false,
    noRefs: true,
    sortKeys: false,
  });

  return header + "\n" + yamlBody;
}
