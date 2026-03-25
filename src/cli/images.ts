import chalk from "chalk";
import { resolve, join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listWorkflows } from "../workflow/registry.js";
import { buildImage, imageExists } from "../container/builder.js";

const selfDir = typeof import.meta.dirname === "string"
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url));
const DOCKERFILES_DIR = resolve(selfDir, "../../dockerfiles");

interface ImageInfo {
  image: string;
  dockerfile: string;
  workflows: string[];
}

const POLYGLOT_IMAGES: ImageInfo[] = [
  { image: "forgectl/code-python312", dockerfile: "Dockerfile.code-python312", workflows: ["code (python)"] },
  { image: "forgectl/code-go122", dockerfile: "Dockerfile.code-go122", workflows: ["code (go)"] },
  { image: "forgectl/code-rust", dockerfile: "Dockerfile.code-rust", workflows: ["code (rust)"] },
];

function getAllImages(): ImageInfo[] {
  const workflows = listWorkflows();
  const imageMap = new Map<string, ImageInfo>();

  for (const wf of workflows) {
    const image = wf.container.image;
    if (!image.startsWith("forgectl/")) continue;

    if (imageMap.has(image)) {
      imageMap.get(image)!.workflows.push(wf.name);
      continue;
    }

    const suffix = image.replace("forgectl/", "");
    const dockerfile = `Dockerfile.${suffix}`;
    const dockerfilePath = join(DOCKERFILES_DIR, dockerfile);

    if (existsSync(dockerfilePath)) {
      imageMap.set(image, { image, dockerfile, workflows: [wf.name] });
    }
  }

  for (const poly of POLYGLOT_IMAGES) {
    if (!imageMap.has(poly.image) && existsSync(join(DOCKERFILES_DIR, poly.dockerfile))) {
      imageMap.set(poly.image, poly);
    }
  }

  return Array.from(imageMap.values());
}

const LANGUAGE_IMAGE_MAP: Record<string, string> = {
  python: "forgectl/code-python312",
  go: "forgectl/code-go122",
  rust: "forgectl/code-rust",
};

function resolveImageForWorkflow(workflowName: string): ImageInfo | undefined {
  const allImages = getAllImages();
  const langImage = LANGUAGE_IMAGE_MAP[workflowName];
  if (langImage) {
    return allImages.find((info) => info.image === langImage);
  }
  return allImages.find((info) => info.workflows.includes(workflowName));
}

export async function imagesListCommand(): Promise<void> {
  const allImages = getAllImages();

  if (allImages.length === 0) {
    console.log("No images found.");
    return;
  }

  console.log(chalk.bold("\nAvailable images:\n"));
  console.log(
    `  ${"IMAGE".padEnd(30)} ${"DOCKERFILE".padEnd(30)} ${"WORKFLOWS".padEnd(25)} STATUS`
  );
  console.log(
    `  ${"─".repeat(30)} ${"─".repeat(30)} ${"─".repeat(25)} ${"─".repeat(10)}`
  );

  for (const info of allImages) {
    const exists = await imageExists(info.image);
    const status = exists
      ? chalk.green("available")
      : chalk.yellow("not built");
    console.log(
      `  ${chalk.cyan(info.image.padEnd(30))} ${info.dockerfile.padEnd(30)} ${info.workflows.join(", ").padEnd(25)} ${status}`
    );
  }
  console.log();
}

export async function imagesBuildCommand(
  workflowName?: string,
  opts?: { all?: boolean }
): Promise<void> {
  if (opts?.all) {
    const allImages = getAllImages();
    if (allImages.length === 0) {
      console.log("No images to build.");
      return;
    }
    for (const info of allImages) {
      await buildSingleImage(info);
    }
    return;
  }

  const name = workflowName || "code";
  const info = resolveImageForWorkflow(name);
  if (!info) {
    console.error(
      `No Dockerfile found for workflow "${name}". Available workflows: ${getAllImages()
        .flatMap((i) => i.workflows)
        .join(", ")}`
    );
    process.exit(1);
    return;
  }

  await buildSingleImage(info);
}

async function buildSingleImage(info: ImageInfo): Promise<void> {
  console.log(
    `Building ${chalk.cyan(info.image)} from ${info.dockerfile}...`
  );
  await buildImage(info.dockerfile, DOCKERFILES_DIR, info.image);
  console.log(chalk.green(`Built ${info.image}`));
}
