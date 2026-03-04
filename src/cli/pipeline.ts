import chalk from "chalk";
import { parsePipeline } from "../pipeline/parser.js";
import { validateDAG, getParallelGroups } from "../pipeline/dag.js";
import { PipelineExecutor } from "../pipeline/executor.js";
import { renderDAG } from "../pipeline/visualize.js";
import { listCheckpoints, loadCheckpoint, revertToCheckpoint } from "../pipeline/checkpoint.js";

export async function pipelineShowCommand(options: { file: string }): Promise<void> {
  const pipeline = parsePipeline(options.file);
  const validation = validateDAG(pipeline);

  if (!validation.valid) {
    console.log(chalk.red("\nPipeline validation errors:"));
    for (const err of validation.errors) {
      console.log(chalk.red(`  - ${err}`));
    }
    process.exit(1);
  }

  renderDAG(pipeline);
}

export async function pipelineRunCommand(options: {
  file: string;
  dryRun?: boolean;
  verbose?: boolean;
  repo?: string;
  maxParallel?: string;
  from?: string;
}): Promise<void> {
  const pipeline = parsePipeline(options.file);

  const executor = new PipelineExecutor(pipeline, {
    dryRun: options.dryRun,
    verbose: options.verbose,
    repo: options.repo,
    maxParallel: options.maxParallel ? parseInt(options.maxParallel, 10) : undefined,
    fromNode: options.from,
  });

  console.log(chalk.bold(`\n🔗 Pipeline: ${pipeline.name}`));
  if (pipeline.description) {
    console.log(chalk.gray(`   ${pipeline.description}`));
  }
  console.log(chalk.gray(`   Run ID: ${executor.runId}\n`));

  const result = await executor.execute();

  // Summary
  console.log();
  if (result.status === "completed") {
    console.log(chalk.green.bold("✔ Pipeline completed successfully"));
  } else if (result.status === "failed") {
    console.log(chalk.red.bold("✗ Pipeline failed"));
  }

  const nodeArray = [...result.nodes.values()];
  const completed = nodeArray.filter(n => n.status === "completed").length;
  const failed = nodeArray.filter(n => n.status === "failed").length;
  const skipped = nodeArray.filter(n => n.status === "skipped").length;
  console.log(chalk.gray(`  ${completed} completed, ${failed} failed, ${skipped} skipped`));
  console.log();

  if (result.status === "failed") process.exit(1);
}

export async function pipelineStatusCommand(options: { file: string }): Promise<void> {
  const pipeline = parsePipeline(options.file);
  const groups = getParallelGroups(pipeline);

  console.log(chalk.bold(`\nPipeline: ${pipeline.name}\n`));

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    console.log(chalk.gray(`Level ${i}: ${group.join(" | ")}`));
  }
  console.log();
}

export async function pipelineRerunCommand(options: {
  file: string;
  from: string;
  verbose?: boolean;
  repo?: string;
}): Promise<void> {
  const pipeline = parsePipeline(options.file);

  // Verify the target node exists
  const nodeIds = pipeline.nodes.map(n => n.id);
  if (!nodeIds.includes(options.from)) {
    console.log(chalk.red(`Node "${options.from}" not found in pipeline.`));
    console.log(chalk.gray(`Available nodes: ${nodeIds.join(", ")}`));
    process.exit(1);
  }

  console.log(chalk.bold(`\n🔄 Re-running pipeline from node: ${options.from}\n`));

  const executor = new PipelineExecutor(pipeline, {
    fromNode: options.from,
    verbose: options.verbose,
    repo: options.repo,
  });

  const result = await executor.execute();

  if (result.status === "completed") {
    console.log(chalk.green.bold("\n✔ Pipeline re-run completed successfully\n"));
  } else {
    console.log(chalk.red.bold("\n✗ Pipeline re-run failed\n"));
    process.exit(1);
  }
}

export async function pipelineRevertCommand(options: {
  file: string;
  to: string;
  pipelineRun?: string;
}): Promise<void> {
  const pipeline = parsePipeline(options.file);

  // Verify the target node exists
  const nodeIds = pipeline.nodes.map(n => n.id);
  if (!nodeIds.includes(options.to)) {
    console.log(chalk.red(`Node "${options.to}" not found in pipeline.`));
    console.log(chalk.gray(`Available nodes: ${nodeIds.join(", ")}`));
    process.exit(1);
  }

  if (!options.pipelineRun) {
    console.log(chalk.red("Must specify --pipeline-run <id> to revert to a checkpoint."));
    process.exit(1);
  }

  const checkpoint = await loadCheckpoint(options.pipelineRun, options.to);
  if (!checkpoint) {
    console.log(chalk.red(`No checkpoint found for node "${options.to}" in run ${options.pipelineRun}.`));

    // Show available checkpoints
    const all = await listCheckpoints(options.pipelineRun);
    if (all.length > 0) {
      console.log(chalk.gray(`Available checkpoints: ${all.map(c => c.nodeId).join(", ")}`));
    }
    process.exit(1);
  }

  console.log(chalk.bold(`\n⏪ Reverting to checkpoint: ${options.to}\n`));
  await revertToCheckpoint(checkpoint);
  console.log(chalk.green("\nReverted successfully.\n"));
}
