import Docker from "dockerode";
import type { ForgectlConfig } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";

const PROBE_TIMEOUT_MS = 30_000;

export async function probeUsageLimit(config: ForgectlConfig, logger: Logger): Promise<boolean> {
  const docker = new Docker();
  const image = config.container?.image ?? "forgectl/code-node20";
  const patterns = config.agent.usage_limit.detection_patterns;
  let container: Docker.Container | undefined;

  try {
    container = await docker.createContainer({
      Image: image,
      Cmd: ["claude", "-p", "Say hello", "--max-turns", "1", "--output-format", "text"],
      WorkingDir: "/workspace",
      User: "node",
      HostConfig: {
        NetworkMode: "bridge",
        Memory: 512 * 1024 * 1024,
      },
      Tty: false,
      OpenStdin: false,
    });

    await container.start();

    const result = await Promise.race([
      container.wait(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS)
      ),
    ]);

    const logs = await container.logs({ stdout: true, stderr: true, follow: false });
    const output = logs.toString("utf-8").toLowerCase();

    if (result.StatusCode !== 0) {
      logger.info("probe", `Probe exited with code ${result.StatusCode}`);
      return false;
    }

    for (const pattern of patterns) {
      if (output.includes(pattern.toLowerCase())) {
        logger.info("probe", `Probe output matched usage limit pattern: "${pattern}"`);
        return false;
      }
    }

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("probe", `Probe failed: ${msg}`);
    return false;
  } finally {
    if (container) {
      try {
        await container.stop({ t: 0 }).catch(() => {});
        await container.remove({ force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}
