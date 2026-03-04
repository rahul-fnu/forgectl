import chalk from "chalk";
import type { PipelineDefinition, NodeExecution } from "./types.js";
import { getParallelGroups } from "./dag.js";

/**
 * Render the DAG in the terminal with status indicators.
 * Uses box-drawing characters for a visual representation.
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

    // Render boxes for this level
    const boxes = group.map(nodeId => {
      const node = nodeMap.get(nodeId)!;
      const state = nodeStates?.get(nodeId);
      return renderBox(nodeId, node.workflow ?? pipeline.defaults?.workflow ?? "code", state);
    });

    // Print boxes side by side
    const maxHeight = Math.max(...boxes.map(b => b.length));
    for (let line = 0; line < maxHeight; line++) {
      const parts = boxes.map(box => box[line] ?? " ".repeat(getBoxWidth(box)));
      console.log("  " + parts.join("  "));
    }

    // Print connector to next level
    if (i < groups.length - 1) {
      const nextGroup = groups[i + 1];
      if (group.length === 1 && nextGroup.length === 1) {
        // Simple linear connector
        console.log("  " + centerPad("│", getBoxWidth(boxes[0])));
        console.log("  " + centerPad("▼", getBoxWidth(boxes[0])));
      } else if (group.length === 1 && nextGroup.length > 1) {
        // Fan-out
        const w = getBoxWidth(boxes[0]);
        console.log("  " + centerPad("│", w));
        const totalWidth = nextGroup.length * 18 + (nextGroup.length - 1) * 2;
        const half = Math.floor(totalWidth / 2);
        console.log("  " + " ".repeat(Math.max(0, Math.floor(w / 2) - half)) + "┌" + "─".repeat(Math.max(1, totalWidth - 2)) + "┐");
        const arrows = nextGroup.map(() => centerPad("▼", 18));
        console.log("  " + arrows.join("  "));
      } else if (group.length > 1 && nextGroup.length === 1) {
        // Fan-in
        const totalWidth = group.length * getBoxWidth(boxes[0]) + (group.length - 1) * 2;
        const pipes = group.map((_, idx) => centerPad("│", getBoxWidth(boxes[idx])));
        console.log("  " + pipes.join("  "));
        console.log("  " + "└" + "─".repeat(Math.max(1, totalWidth - 2)) + "┘");
        console.log("  " + centerPad("▼", totalWidth));
      } else {
        // Generic connector
        const pipes = group.map((_, idx) => centerPad("│", getBoxWidth(boxes[idx])));
        console.log("  " + pipes.join("  "));
        console.log("  " + pipes.map(p => p.replace("│", "▼")).join("  "));
      }
    }
  }
  console.log();
}

function renderBox(nodeId: string, workflow: string, state?: NodeExecution): string[] {
  const status = formatStatus(state);
  const label = nodeId;
  const detail = `${status} [${workflow}]`;
  const width = Math.max(label.length, stripAnsi(detail).length) + 4;

  return [
    "┌" + "─".repeat(width) + "┐",
    "│ " + label.padEnd(width - 2) + " │",
    "│ " + detail + " ".repeat(Math.max(0, width - 2 - stripAnsi(detail).length)) + " │",
    "└" + "─".repeat(width) + "┘",
  ];
}

function getBoxWidth(box: string[]): number {
  return stripAnsi(box[0]).length;
}

function centerPad(char: string, width: number): string {
  const pad = Math.floor((width - 1) / 2);
  return " ".repeat(pad) + char + " ".repeat(width - pad - 1);
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;]*m/g, "");
}

function formatStatus(state?: NodeExecution): string {
  if (!state) return chalk.gray("-- pending");

  switch (state.status) {
    case "completed": {
      const dur = state.startedAt && state.completedAt
        ? Math.round((new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime()) / 1000)
        : null;
      return chalk.green(`OK${dur ? ` ${dur}s` : ""}`);
    }
    case "running":
      return chalk.blue(".. running");
    case "failed":
      return chalk.red("XX failed");
    case "skipped":
      return chalk.dim("-- skipped");
    case "pending":
    default:
      return chalk.gray("-- pending");
  }
}
