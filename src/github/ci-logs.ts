const API_BASE = "https://api.github.com";

/**
 * Fetch CI error logs from GitHub Actions for a failed SHA.
 * Downloads actual job logs (not just annotations) to get real compiler errors.
 * Returns the combined error output, or null if unavailable.
 */
export async function fetchCIErrorLog(
  owner: string,
  repo: string,
  sha: string,
  headers: Record<string, string>,
): Promise<string | null> {
  try {
    const runsUrl = `${API_BASE}/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=5`;
    const runsResp = await fetch(runsUrl, { headers });
    if (!runsResp.ok) return null;

    const runsData = (await runsResp.json()) as {
      workflow_runs?: Array<{ id: number; conclusion: string }>;
    };
    const failedWorkflow = (runsData.workflow_runs ?? []).find((r) => r.conclusion === "failure");
    if (!failedWorkflow) return null;

    const jobsUrl = `${API_BASE}/repos/${owner}/${repo}/actions/runs/${failedWorkflow.id}/jobs`;
    const jobsResp = await fetch(jobsUrl, { headers });
    if (!jobsResp.ok) return null;

    const jobsData = (await jobsResp.json()) as {
      jobs?: Array<{ id: number; name: string; conclusion: string }>;
    };
    const failedJobs = (jobsData.jobs ?? []).filter((j) => j.conclusion === "failure");
    if (failedJobs.length === 0) return null;

    const failedJob = failedJobs[0];
    const logUrl = `${API_BASE}/repos/${owner}/${repo}/actions/jobs/${failedJob.id}/logs`;
    const logResp = await fetch(logUrl, {
      headers,
      redirect: "follow",
    });
    if (!logResp.ok) return null;

    const fullLog = await logResp.text();
    const lines = fullLog.split("\n");

    const errorPattern = /error\[E\d+\]|^error:|cannot find|not found|expected .* found|no method named|mismatched types|missing field|unresolved import|failed to compile/i;
    const contextLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const clean = lines[i].replace(/\x1b\[[0-9;]*m/g, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "");
      if (errorPattern.test(clean)) {
        const start = Math.max(0, i - 2);
        const end = Math.min(lines.length, i + 6);
        for (let j = start; j < end; j++) {
          const ctx = lines[j].replace(/\x1b\[[0-9;]*m/g, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "");
          if (!contextLines.includes(ctx)) {
            contextLines.push(ctx);
          }
        }
      }
    }

    if (contextLines.length > 0) {
      return contextLines.slice(0, 150).join("\n");
    }

    // Fallback: last 80 lines
    return lines.slice(-80).map((l) =>
      l.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, ""),
    ).join("\n");
  } catch {
    return null;
  }
}
