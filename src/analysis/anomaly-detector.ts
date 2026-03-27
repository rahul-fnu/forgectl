import type { OutcomeRow } from "../storage/repositories/outcomes.js";

export type AnomalyType =
  | "repeated_validation_failure"
  | "cost_spike"
  | "success_rate_drop"
  | "systemic_failure"
  | "coverage_decay";

export type AnomalySeverity = "info" | "warning" | "critical";

export interface Anomaly {
  type: AnomalyType;
  severity: AnomalySeverity;
  summary: string;
  evidence: string[];
  suggestedAction: string;
}

export interface AnomalyDetectorConfig {
  enabled: boolean;
  repeated_failure_threshold: number;
  cost_spike_multiplier: number;
  success_rate_floor: number;
}

export const DEFAULT_CONFIG: AnomalyDetectorConfig = {
  enabled: true,
  repeated_failure_threshold: 3,
  cost_spike_multiplier: 3,
  success_rate_floor: 0.7,
};

export interface RunCostInfo {
  runId: string;
  costUsd: number;
}

export interface GapIssue {
  id: string;
  createdAt: string;
}

export function detectAnomalies(
  outcomes: OutcomeRow[],
  costsByRun: RunCostInfo[],
  gapIssues: GapIssue[],
  config: Partial<AnomalyDetectorConfig> = {},
): Anomaly[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enabled) return [];

  const anomalies: Anomaly[] = [];

  anomalies.push(...detectRepeatedValidationFailures(outcomes, cfg));
  anomalies.push(...detectCostSpike(costsByRun, cfg));
  anomalies.push(...detectSuccessRateDrop(outcomes, cfg));
  anomalies.push(...detectSystemicFailure(outcomes));
  anomalies.push(...detectCoverageDecay(gapIssues));

  return anomalies;
}

function detectRepeatedValidationFailures(
  outcomes: OutcomeRow[],
  cfg: AnomalyDetectorConfig,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const windowSize = Math.max(cfg.repeated_failure_threshold * 2, 6);
  const recent = outcomes.slice(-windowSize);

  const stepFailures = new Map<string, number>();
  for (const row of recent) {
    if (!row.rawEventsJson) continue;
    try {
      const events: Array<{ type?: string; data?: { step?: string; name?: string } }> = JSON.parse(row.rawEventsJson);
      for (const e of events) {
        if (e.type === "validation_step" || e.type === "failed") {
          const stepName = e.data?.step ?? e.data?.name;
          if (stepName) {
            stepFailures.set(stepName, (stepFailures.get(stepName) ?? 0) + 1);
          }
        }
      }
    } catch {
      // skip malformed JSON
    }
  }

  // Also check failureMode for runs without detailed events
  const failureModes = new Map<string, number>();
  for (const row of recent) {
    if (row.failureMode) {
      failureModes.set(row.failureMode, (failureModes.get(row.failureMode) ?? 0) + 1);
    }
  }

  for (const [step, count] of stepFailures) {
    if (count >= cfg.repeated_failure_threshold) {
      anomalies.push({
        type: "repeated_validation_failure",
        severity: count >= cfg.repeated_failure_threshold * 2 ? "critical" : "warning",
        summary: `Validation step "${step}" failed in ${count} of last ${recent.length} runs`,
        evidence: [`step=${step}`, `failures=${count}`, `window=${recent.length}`],
        suggestedAction: `Investigate why "${step}" keeps failing. Consider fixing the underlying issue or adjusting the validation step.`,
      });
    }
  }

  for (const [mode, count] of failureModes) {
    if (count >= cfg.repeated_failure_threshold && !stepFailures.has(mode)) {
      anomalies.push({
        type: "repeated_validation_failure",
        severity: count >= cfg.repeated_failure_threshold * 2 ? "critical" : "warning",
        summary: `Failure mode "${mode}" occurred in ${count} of last ${recent.length} runs`,
        evidence: [`failureMode=${mode}`, `occurrences=${count}`, `window=${recent.length}`],
        suggestedAction: `Investigate recurring "${mode}" failures. Check if a systemic issue is causing repeated failures.`,
      });
    }
  }

  return anomalies;
}

function detectCostSpike(
  costsByRun: RunCostInfo[],
  cfg: AnomalyDetectorConfig,
): Anomaly[] {
  if (costsByRun.length < 2) return [];

  const sorted = [...costsByRun];
  const latest = sorted[sorted.length - 1];
  const previous = sorted.slice(0, -1);
  const avgCost = previous.reduce((sum, r) => sum + r.costUsd, 0) / previous.length;

  if (avgCost <= 0) return [];

  const ratio = latest.costUsd / avgCost;
  if (ratio > cfg.cost_spike_multiplier) {
    return [{
      type: "cost_spike",
      severity: ratio > cfg.cost_spike_multiplier * 2 ? "critical" : "warning",
      summary: `Run ${latest.runId} cost $${latest.costUsd.toFixed(4)} which is ${ratio.toFixed(1)}x the rolling average of $${avgCost.toFixed(4)}`,
      evidence: [
        `runId=${latest.runId}`,
        `cost=${latest.costUsd.toFixed(4)}`,
        `rollingAvg=${avgCost.toFixed(4)}`,
        `ratio=${ratio.toFixed(1)}`,
      ],
      suggestedAction: `Review the run for excessive token usage. Consider setting a budget cap or investigating why this run consumed significantly more resources.`,
    }];
  }

  return [];
}

function detectSuccessRateDrop(
  outcomes: OutcomeRow[],
  cfg: AnomalyDetectorConfig,
): Anomaly[] {
  const recent = outcomes.slice(-10);
  if (recent.length < 5) return [];

  const successes = recent.filter(r => r.status === "success").length;
  const rate = successes / recent.length;

  if (rate < cfg.success_rate_floor) {
    return [{
      type: "success_rate_drop",
      severity: rate < cfg.success_rate_floor / 2 ? "critical" : "warning",
      summary: `Success rate is ${(rate * 100).toFixed(0)}% over the last ${recent.length} runs (threshold: ${(cfg.success_rate_floor * 100).toFixed(0)}%)`,
      evidence: [
        `successes=${successes}`,
        `total=${recent.length}`,
        `rate=${(rate * 100).toFixed(1)}%`,
        `threshold=${(cfg.success_rate_floor * 100).toFixed(0)}%`,
      ],
      suggestedAction: `Investigate recent failures. Check if a configuration change, dependency update, or environment issue is causing the drop.`,
    }];
  }

  return [];
}

function detectSystemicFailure(outcomes: OutcomeRow[]): Anomaly[] {
  const signatureCounts = new Map<string, Set<string>>();

  for (const row of outcomes) {
    if (!row.failureMode || !row.taskId) continue;
    const signature = row.failureDetail
      ? `${row.failureMode}:${normalizeFailureDetail(row.failureDetail)}`
      : row.failureMode;
    const issues = signatureCounts.get(signature) ?? new Set();
    issues.add(row.taskId);
    signatureCounts.set(signature, issues);
  }

  const anomalies: Anomaly[] = [];
  for (const [signature, issues] of signatureCounts) {
    if (issues.size >= 3) {
      anomalies.push({
        type: "systemic_failure",
        severity: issues.size >= 5 ? "critical" : "warning",
        summary: `Failure signature "${signature}" appears across ${issues.size} different issues`,
        evidence: [
          `signature=${signature}`,
          `affectedIssues=${issues.size}`,
          `issueIds=${[...issues].slice(0, 5).join(",")}`,
        ],
        suggestedAction: `This failure pattern is systemic. Investigate the root cause across issues rather than fixing individually.`,
      });
    }
  }

  return anomalies;
}

function normalizeFailureDetail(detail: string): string {
  return detail
    .replace(/\b[0-9a-f]{6,}\b/g, "<hash>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}[:\d.]*/g, "<timestamp>")
    .replace(/line \d+/gi, "line <N>")
    .trim()
    .slice(0, 100);
}

function detectCoverageDecay(gapIssues: GapIssue[]): Anomaly[] {
  if (gapIssues.length < 5) return [];

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentGaps = gapIssues.filter(g => g.createdAt >= oneWeekAgo);

  if (recentGaps.length >= 5) {
    return [{
      type: "coverage_decay",
      severity: recentGaps.length >= 10 ? "critical" : "warning",
      summary: `${recentGaps.length} coverage gap issues created in the last week`,
      evidence: [
        `gapCount=${recentGaps.length}`,
        `threshold=5`,
        `period=7d`,
        `issueIds=${recentGaps.slice(0, 5).map(g => g.id).join(",")}`,
      ],
      suggestedAction: `Coverage is declining. Review recent changes that may have reduced test coverage and prioritize gap issues.`,
    }];
  }

  return [];
}
