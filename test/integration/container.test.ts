import { describe, it, expect, afterEach, beforeAll } from "vitest";
import Docker from "dockerode";

// Skip if FORGECTL_SKIP_DOCKER is not explicitly set to "false"
const skipDocker = process.env.FORGECTL_SKIP_DOCKER !== "false";

const docker = new Docker();

describe.skipIf(skipDocker)("container integration", () => {
  let container: Docker.Container | null = null;

  beforeAll(async () => {
    // Ensure we have a simple image to test with
    try {
      await docker.getImage("alpine:latest").inspect();
    } catch {
      await new Promise<void>((resolve, reject) => {
        docker.pull("alpine:latest", (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (err: Error | null) => {
            if (err) return reject(err);
            resolve();
          });
        });
      });
    }
  });

  afterEach(async () => {
    if (container) {
      try { await container.stop({ t: 1 }); } catch { /* ignore */ }
      try { await container.remove({ force: true }); } catch { /* ignore */ }
      container = null;
    }
  });

  it("creates and starts a container", async () => {
    container = await docker.createContainer({
      Image: "alpine:latest",
      Cmd: ["sleep", "60"],
      Tty: false,
    });
    await container.start();
    const info = await container.inspect();
    expect(info.State.Running).toBe(true);
  });

  it("exec captures stdout", async () => {
    container = await docker.createContainer({
      Image: "alpine:latest",
      Cmd: ["sleep", "60"],
      Tty: false,
    });
    await container.start();

    const exec = await container.exec({
      Cmd: ["echo", "hello world"],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    const chunks: Buffer[] = [];

    await new Promise<void>((resolve) => {
      docker.modem.demuxStream(stream,
        { write: (chunk: Buffer) => chunks.push(chunk) } as unknown as NodeJS.WritableStream,
        { write: () => {} } as unknown as NodeJS.WritableStream
      );
      stream.on("end", () => resolve());
    });

    const output = Buffer.concat(chunks).toString("utf-8").trim();
    expect(output).toBe("hello world");
  });

  it("exec captures stderr separately", async () => {
    container = await docker.createContainer({
      Image: "alpine:latest",
      Cmd: ["sleep", "60"],
      Tty: false,
    });
    await container.start();

    const exec = await container.exec({
      Cmd: ["sh", "-c", "echo error >&2"],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    const stderrChunks: Buffer[] = [];

    await new Promise<void>((resolve) => {
      docker.modem.demuxStream(stream,
        { write: () => {} } as unknown as NodeJS.WritableStream,
        { write: (chunk: Buffer) => stderrChunks.push(chunk) } as unknown as NodeJS.WritableStream
      );
      stream.on("end", () => resolve());
    });

    const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
    expect(stderr).toBe("error");
  });

  it("exec returns correct exit code", async () => {
    container = await docker.createContainer({
      Image: "alpine:latest",
      Cmd: ["sleep", "60"],
      Tty: false,
    });
    await container.start();

    // Exit code 0
    const exec0 = await container.exec({
      Cmd: ["true"],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream0 = await exec0.start({ hijack: true, stdin: false });
    await new Promise<void>(r => stream0.on("end", () => r()));
    const info0 = await exec0.inspect();
    expect(info0.ExitCode).toBe(0);

    // Exit code 1
    const exec1 = await container.exec({
      Cmd: ["false"],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream1 = await exec1.start({ hijack: true, stdin: false });
    await new Promise<void>(r => stream1.on("end", () => r()));
    const info1 = await exec1.inspect();
    expect(info1.ExitCode).toBe(1);
  });

  it("stops and removes a container", async () => {
    container = await docker.createContainer({
      Image: "alpine:latest",
      Cmd: ["sleep", "60"],
      Tty: false,
    });
    await container.start();
    const id = container.id;

    await container.stop({ t: 1 });
    await container.remove({ force: true });

    // Verify it's gone
    try {
      await docker.getContainer(id).inspect();
      expect.fail("Container should have been removed");
    } catch (err: unknown) {
      expect((err as { statusCode: number }).statusCode).toBe(404);
    }

    container = null; // Prevent afterEach from trying to clean up
  });
});
