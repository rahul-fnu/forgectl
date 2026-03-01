import Docker from "dockerode";

const docker = new Docker();

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

export async function ensureImage(
  imageName?: string,
  dockerfilePath?: string,
  contextPath?: string
): Promise<string> {
  if (dockerfilePath && contextPath) {
    const tag = `forgectl-custom:latest`;
    await buildImage(dockerfilePath, contextPath, tag);
    return tag;
  }

  const name = imageName || "forgectl/code-node20";
  if (!(await imageExists(name))) {
    await pullImage(name);
  }
  return name;
}
