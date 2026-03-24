import Docker from "dockerode";
import { execInContainer } from "./runner.js";

const docker = new Docker();

/**
 * Create a Docker network for a run (only for allowlist mode).
 */
export async function createIsolatedNetwork(name: string): Promise<Docker.Network> {
  return docker.createNetwork({
    Name: name,
    Driver: "bridge",
    Internal: false,
  });
}

/**
 * Apply iptables firewall inside a container (only for allowlist mode).
 * This restricts outbound traffic to only the allowed domains.
 */
export async function applyFirewall(
  container: Docker.Container,
  allowedDomains: string[]
): Promise<void> {
  const domainsStr = allowedDomains.join(",");
  await execInContainer(container, [
    "/bin/bash", "/usr/local/bin/init-firewall.sh",
  ], {
    env: [`FORGECTL_ALLOWED_DOMAINS=${domainsStr}`],
    user: "root",
  });
}

/**
 * Remove a Docker network.
 */
export async function removeNetwork(name: string): Promise<void> {
  try {
    const network = docker.getNetwork(name);
    await network.remove();
  } catch { /* ignore */ }
}

/**
 * Verify firewall is working by testing a blocked domain.
 * Returns true if the domain is blocked (expected), false if it's reachable (unexpected).
 */
async function verifyFirewall(container: Docker.Container): Promise<boolean> {
  const result = await execInContainer(container, [
    "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "3", "https://example.com",
  ]);
  // If curl fails or times out, firewall is working
  return result.exitCode !== 0;
}
