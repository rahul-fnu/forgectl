import Docker from "dockerode";
import { readFileSync } from "node:fs";
import { ImageCache, type CacheKeyInputs } from "./cache.js";

const docker = new Docker();
const cache = new ImageCache(docker);

export async function imageExists(imageName: string): Promise<boolean> {
  try {
    await docker.getImage(imageName).inspect();
    return true;
  } catch {
    return false;
  }
}

export async function pullImage(imageName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    docker.pull(imageName, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

export async function buildImage(
  dockerfilePath: string,
  contextPath: string,
  tag: string
): Promise<void> {
  const stream = await docker.buildImage(
    { context: contextPath, src: [dockerfilePath] },
    { t: tag, dockerfile: dockerfilePath }
  );
  return new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

export interface EnsureImageOptions {
  imageName?: string;
  dockerfilePath?: string;
  contextPath?: string;
  tools?: string[];
  networkMode?: string;
  cacheEnabled?: boolean;
}

export async function ensureImage(
  imageNameOrOpts?: string | EnsureImageOptions,
  dockerfilePath?: string,
  contextPath?: string
): Promise<string> {
  // Support both old and new calling conventions
  let opts: EnsureImageOptions;
  if (typeof imageNameOrOpts === "string" || imageNameOrOpts === undefined) {
    opts = { imageName: imageNameOrOpts, dockerfilePath, contextPath };
  } else {
    opts = imageNameOrOpts;
  }

  if (opts.dockerfilePath && opts.contextPath) {
    const cacheEnabled = opts.cacheEnabled !== false;
    let dockerfileContent = "";
    try {
      dockerfileContent = readFileSync(opts.dockerfilePath, "utf-8");
    } catch {
      // If we can't read the Dockerfile, skip caching
    }

    if (cacheEnabled && dockerfileContent) {
      const cacheInputs: CacheKeyInputs = {
        baseImage: opts.imageName ?? "forgectl-custom",
        dockerfileInstructions: dockerfileContent,
        tools: opts.tools ?? [],
        networkMode: opts.networkMode ?? "open",
      };
      const cacheKey = cache.getCacheKey(cacheInputs);

      if (await cache.hasCache(cacheKey)) {
        return cache.getCacheTag(cacheKey);
      }

      const tag = `forgectl-custom:latest`;
      await buildImage(opts.dockerfilePath, opts.contextPath, tag);
      await cache.tagCache(tag, cacheKey);
      return cache.getCacheTag(cacheKey);
    }

    const tag = `forgectl-custom:latest`;
    await buildImage(opts.dockerfilePath, opts.contextPath, tag);
    return tag;
  }

  const name = opts.imageName || "forgectl/code-node20";
  if (!(await imageExists(name))) {
    await pullImage(name);
  }
  return name;
}
