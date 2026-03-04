import chalk from "chalk";
import type { PipelineDefinition, NodeExecution } from "./types.js";
import { getParallelGroups } from "./dag.js";

/**
 * Render the DAG in the terminal with status indicators.
 */
export function renderDAG(
  pipeline: PipelineDefinition,
  nodeStates?: Map<string, NodeExecution>,
): void {
  const groups = getParallelGroups(pipeline);
  const nodeMap = new Map(pipeline.nodes.map(n => [n.id, n]));

  console.log(chalk.bold(`\nPipeline: ${pipeline.name} (${pipeline.nodes.length} nodes)`));
  if (pipeline.description) {
    console.log(chalk.gray(`  ${pipeline.description}`));
  }
  console.log();

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const parts: string[] = [];

    for (const nodeId of group) {
      const node = nodeMap.get(nodeId)!;
      const state = nodeStates?.get(nodeId);
      const status = formatStatus(state);
      const workflow = node.workflow ?? pipeline.defaults?.workflow ?? "code";
      parts.push(`${nodeId} ${status} [${workflow}]`);
    }

    const prefix = i === 0 ? "  " : "  │\n  ▼\n  ";
    console.log(`${prefix}Level ${i}: ${parts.join(" | ")}`);
  }
  console.log();
}

function formatStatus(state?: NodeExecution): string {
  if (!state) return chalk.gray("⏳");

  switch (state.status) {
    case "completed": {
      const dur = state.startedAt && state.completedAt
        ? Math.round((new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime()) / 1000)
        : null;
      return chalk.green(`✅${dur ? ` ${dur}s` : ""}`);
    }
    case "running":
      return chalk.blue("🔄 running...");
    case "failed":
      return chalk.red("❌ failed");
    case "skipped":
      return chalk.dim("⏭️  skipped");
    case "pending":
    default:
      return chalk.gray("⏳ pending");
  }
}
