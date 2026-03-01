import Docker from "dockerode";
import type { RunPlan } from "../workflow/types.js";

const docker = new Docker();

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Create and start a container based on the RunPlan.
 */
export async function createContainer(
  plan: RunPlan,
  binds: string[]
): Promise<Docker.Container> {
  const networkMode = plan.container.network.dockerNetwork;

  const container = await docker.createContainer({
    Image: plan.container.image,
    Cmd: ["sleep", "infinity"],
    WorkingDir: plan.input.mountPath,
    HostConfig: {
      NetworkMode: networkMode,
      Memory: parseMemory(plan.container.resources.memory),
      NanoCpus: plan.container.resources.cpus * 1e9,
      Binds: binds,
      CapAdd: plan.container.network.mode === "allowlist" ? ["NET_ADMIN"] : [],
    },
    Tty: false,
    OpenStdin: false,
  });

  await container.start();
  return container;
}

/**
 * Execute a command inside a running container.
 * Returns stdout, stderr, exit code, and duration.
 */
export async function execInContainer(
  container: Docker.Container,
  cmd: string[],
  options?: { env?: string[]; user?: string; workingDir?: string; timeout?: number }
): Promise<ExecResult> {
  const start = Date.now();

  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Env: options?.env,
    User: options?.user,
    WorkingDir: options?.workingDir,
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // dockerode multiplexes stdout/stderr on the same stream
    // We need to demux it
    docker.modem.demuxStream(stream,
      { write: (chunk: Buffer) => stdoutChunks.push(chunk) } as unknown as NodeJS.WritableStream,
      { write: (chunk: Buffer) => stderrChunks.push(chunk) } as unknown as NodeJS.WritableStream
    );

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeout) {
      timeoutHandle = setTimeout(() => {
        stream.destroy();
        reject(new Error(`Command timed out after ${options.timeout}ms`));
      }, options.timeout);
    }

    stream.on("end", async () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const inspection = await exec.inspect();
      resolve({
        exitCode: inspection.ExitCode ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        durationMs: Date.now() - start,
      });
    });

    stream.on("error", (err: Error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    });
  });
}

/**
 * Stop and remove a container, handling errors gracefully.
 */
export async function destroyContainer(container: Docker.Container): Promise<void> {
  try { await container.stop({ t: 5 }); } catch { /* ignore */ }
  try { await container.remove({ force: true }); } catch { /* ignore */ }
}

function parseMemory(mem: string): number {
  const match = mem.match(/^(\d+)(g|m)$/i);
  if (!match) return 4 * 1024 * 1024 * 1024; // default 4GB
  const val = parseInt(match[1], 10);
  return match[2].toLowerCase() === "g" ? val * 1024 ** 3 : val * 1024 ** 2;
}
