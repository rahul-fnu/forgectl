import { compileExpression } from "filtrex";
import type { PipelineDefinition } from "./types.js";

/** Map of node ID to its current execution status — passed as context to evaluateCondition */
export type NodeStatusContext = Record<string, "completed" | "failed" | "skipped">;

/** Thrown when a condition expression has invalid syntax */
export class ConditionSyntaxError extends Error {
  constructor(expression: string, cause?: unknown) {
    super(
      `Condition syntax error in expression: ${JSON.stringify(expression)}${
        cause instanceof Error ? ` — ${cause.message}` : ""
      }`,
    );
    this.name = "ConditionSyntaxError";
  }
}

/** Thrown when a condition expression references a variable not in the context */
export class ConditionVariableError extends Error {
  constructor(variableName: string, expression: string) {
    super(
      `Condition references unknown node "${variableName}" in expression: ${JSON.stringify(expression)}`,
    );
    this.name = "ConditionVariableError";
  }
}

/**
 * Evaluate a filtrex condition expression against a map of node statuses.
 *
 * @param expression - A filtrex expression, e.g. `build == "completed"`
 * @param context    - Map of node IDs to their current status
 * @returns          - true if the condition holds, false otherwise
 * @throws ConditionSyntaxError   - if the expression cannot be parsed
 * @throws ConditionVariableError - if the expression references a node not in context
 */
export function evaluateCondition(expression: string, context: NodeStatusContext): boolean {
  // We capture the expression in the closure so we can include it in errors
  const captured = expression;

  let compiledFn: (obj: Record<string, unknown>) => unknown;
  try {
    compiledFn = compileExpression(expression, {
      customProp(name, _get, obj) {
        if (!(name in obj)) {
          throw new ConditionVariableError(name, captured);
        }
        return (obj as Record<string, unknown>)[name];
      },
    });
  } catch (err) {
    // Re-throw our own typed errors unchanged
    if (err instanceof ConditionVariableError) throw err;
    throw new ConditionSyntaxError(expression, err);
  }

  // filtrex catches errors from customProp and returns them as the result value
  // rather than rethrowing. We must detect that case and rethrow.
  const result = compiledFn(context as Record<string, unknown>);

  if (result instanceof ConditionVariableError) throw result;
  if (result instanceof Error) throw new ConditionSyntaxError(expression, result);

  return Boolean(result);
}

/**
 * Post-parse transform that expands `if_failed` / `if_passed` shorthands into
 * full `condition` strings and auto-populates `depends_on`.
 *
 * Must be called after Zod schema parsing.  Returns a new PipelineDefinition
 * (original nodes are not mutated).
 *
 * @throws Error if both `condition` and a shorthand field are set on the same node
 */
export function expandShorthands(pipeline: PipelineDefinition): PipelineDefinition {
  const expandedNodes = pipeline.nodes.map(node => {
    const hasCondition = node.condition !== undefined;
    const hasIfFailed = node.if_failed !== undefined;
    const hasIfPassed = node.if_passed !== undefined;

    if (hasCondition && (hasIfFailed || hasIfPassed)) {
      const shorthand = hasIfFailed ? "if_failed" : "if_passed";
      throw new Error(
        `Node "${node.id}" has both "condition" and "${shorthand}" set — they are mutually exclusive`,
      );
    }

    if (!hasIfFailed && !hasIfPassed) {
      // Nothing to expand — return node unchanged
      return node;
    }

    // Determine which shorthand we're expanding
    const targetId = hasIfFailed ? node.if_failed! : node.if_passed!;
    const conditionExpr = hasIfFailed
      ? `${targetId} == "failed"`
      : `${targetId} == "completed"`;

    // Auto-add target to depends_on if not already present
    const existingDeps = node.depends_on ?? [];
    const newDeps = existingDeps.includes(targetId)
      ? existingDeps
      : [...existingDeps, targetId];

    // Build new node object (do not mutate — Zod objects may be frozen)
    const { if_failed: _f, if_passed: _p, ...rest } = node;
    return {
      ...rest,
      condition: conditionExpr,
      depends_on: newDeps,
    };
  });

  return { ...pipeline, nodes: expandedNodes };
}
