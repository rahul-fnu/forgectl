import chalk from "chalk";
import { ImageCache } from "../container/cache.js";
import { getWorkflow } from "../workflow/registry.js";
import { formatDuration } from "../utils/duration.js";
import { ensureImage } from "../container/builder.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export async function cacheListCommand(): Promise<void> {
  const cache = new ImageCache();
  const images = await cache.listCached();

  if (images.length === 0) {
    console.log("No cached images found.");
    return;
  }

  console.log(chalk.bold("\nCached images:\n"));
  console.log(
    `  ${"WORKFLOW".padEnd(20)} ${"TAG".padEnd(14)} ${"SIZE".padEnd(10)} AGE`
  );
  console.log(`  ${"─".repeat(20)} ${"─".repeat(14)} ${"─".repeat(10)} ${"─".repeat(10)}`);

  const now = Date.now();
  for (const img of images) {
    const ageMs = now - img.createdAt.getTime();
    console.log(
      `  ${chalk.cyan(img.workflowName.padEnd(20))} ${img.tag.padEnd(14)} ${formatBytes(img.size).padEnd(10)} ${formatDuration(ageMs)} ago`
    );
  }
  console.log();
}

export async function cacheClearCommand(opts: {
  workflow?: string;
  olderThan?: string;
}): Promise<void> {
  const cache = new ImageCache();
  const removed = await cache.pruneCache({
    workflowName: opts.workflow,
    olderThan: opts.olderThan,
  });

  if (removed === 0) {
    console.log("No cached images matched the criteria.");
  } else {
    console.log(`Removed ${removed} cached image${removed === 1 ? "" : "s"}.`);
  }
}

export async function cachePrebuildCommand(workflowName: string): Promise<void> {
  const workflow = getWorkflow(workflowName);
  console.log(`Building and caching image for workflow: ${chalk.cyan(workflow.name)}`);

  await ensureImage({
    imageName: workflow.container.image,
    tools: workflow.tools,
    networkMode: workflow.container.network.mode,
    cacheEnabled: true,
  });

  console.log(chalk.green(`Image cached for workflow: ${workflow.name}`));
}
