import type { OutcomeRepository } from "../storage/repositories/outcomes.js";
import type { TrackerAdapter } from "../tracker/types.js";
import type { Logger } from "../logging/logger.js";
import {
  detectAnomalies as detectStructuredAnomalies,
  type AnomalyDetectorConfig,
  type Anomaly as StructuredAnomaly,
  type RunCostInfo,
  type GapIssue,
} from "./anomaly-detector.js";
import {
  dispatchReactiveIssues,
  type ReactiveConfig,
} from "./reactive-dispatch.js";

export interface MetricsLoopConfig {
  enabled: boolean;
  poll_interval_ms: number;
  auto_create_issues: boolean;
  max_issues_per_day: number;
  repeated_failure_threshold: number;
  cost_spike_multiplier: number;
  success_rate_floor: number;
}

export const DEFAULT_METRICS_LOOP_CONFIG: MetricsLoopConfig = {
  enabled: false,
  poll_interval_ms: 300_000,
  auto_create_issues: true,
  max_issues_per_day: 5,
  repeated_failure_threshold: 3,
  cost_spike_multiplier: 3,
  success_rate_floor: 0.7,
};

export interface MetricsLoopDeps {
  outcomeRepo: OutcomeRepository;
  tracker: TrackerAdapter;
  logger: Logger;
  costsByRun?: () => RunCostInfo[];
  gapIssues?: () => GapIssue[];
}

export interface MetricsLoopResult {
  structuredAnomalies: StructuredAnomaly[];
  createdIssues: string[];
}

export class ReactiveMetricsLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly config: MetricsLoopConfig;
  private readonly deps: MetricsLoopDeps;

  constructor(config: Partial<MetricsLoopConfig>, deps: MetricsLoopDeps) {
    this.config = { ...DEFAULT_METRICS_LOOP_CONFIG, ...config };
    this.deps = deps;
  }

  start(): void {
    if (this.timer || !this.config.enabled) return;
    this.deps.logger.info("metrics-loop", `Starting reactive metrics loop (interval=${this.config.poll_interval_ms}ms)`);
    this.timer = setInterval(() => void this.tick(), this.config.poll_interval_ms);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.deps.logger.info("metrics-loop", "Stopped reactive metrics loop");
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  async tick(): Promise<MetricsLoopResult> {
    if (this.running) {
      return { structuredAnomalies: [], createdIssues: [] };
    }
    this.running = true;
    try {
      return await this.evaluate();
    } finally {
      this.running = false;
    }
  }

  async evaluate(): Promise<MetricsLoopResult> {
    const { outcomeRepo, tracker, logger } = this.deps;

    const outcomes = outcomeRepo.findAll();
    if (outcomes.length === 0) {
      return { structuredAnomalies: [], createdIssues: [] };
    }

    const detectorConfig: Partial<AnomalyDetectorConfig> = {
      enabled: true,
      repeated_failure_threshold: this.config.repeated_failure_threshold,
      cost_spike_multiplier: this.config.cost_spike_multiplier,
      success_rate_floor: this.config.success_rate_floor,
    };
    const costsByRun = this.deps.costsByRun?.() ?? [];
    const gapIssues = this.deps.gapIssues?.() ?? [];

    const structuredAnomalies = detectStructuredAnomalies(outcomes, costsByRun, gapIssues, detectorConfig);

    if (structuredAnomalies.length > 0) {
      logger.warn("metrics-loop", `Detected ${structuredAnomalies.length} anomaly(ies): ${structuredAnomalies.map(a => a.type).join(", ")}`);
    }

    const reactiveConfig: ReactiveConfig = {
      auto_create_issues: this.config.auto_create_issues,
      max_issues_per_day: this.config.max_issues_per_day,
    };

    const createdIssues = await dispatchReactiveIssues(outcomes, tracker, reactiveConfig, logger);

    for (const anomaly of structuredAnomalies) {
      if (anomaly.severity === "critical" || anomaly.severity === "warning") {
        if (!this.config.auto_create_issues) continue;

        const title = buildAnomalyIssueTitle(anomaly);
        const description = buildAnomalyIssueDescription(anomaly);

        if (tracker.createIssue) {
          try {
            let existingTitles: string[] = [];
            try {
              const existing = await tracker.fetchIssuesByStates(["open", "in_progress", "todo", "Todo", "In Progress"]);
              existingTitles = existing.map(i => i.title);
            } catch {
              // dedup check failed, proceed anyway
            }

            if (existingTitles.some(t => t === title)) {
              logger.info("metrics-loop", `Skipping duplicate anomaly issue: ${title}`);
              continue;
            }

            const id = await tracker.createIssue(title, description, ["reactive-maintenance"]);
            createdIssues.push(id);
            logger.info("metrics-loop", `Created anomaly issue ${id}: ${title}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("metrics-loop", `Failed to create anomaly issue: ${msg}`);
          }
        }
      }
    }

    if (createdIssues.length > 0) {
      logger.info("metrics-loop", `Reactive loop created ${createdIssues.length} issue(s): ${createdIssues.join(", ")}`);
    }

    return { structuredAnomalies, createdIssues };
  }
}

function buildAnomalyIssueTitle(anomaly: StructuredAnomaly): string {
  const typeLabel = anomaly.type.replace(/_/g, " ");
  return `[reactive] Investigate ${typeLabel}`;
}

function buildAnomalyIssueDescription(anomaly: StructuredAnomaly): string {
  return [
    `**Anomaly detected:** ${anomaly.summary}`,
    "",
    `**Severity:** ${anomaly.severity}`,
    `**Type:** \`${anomaly.type}\``,
    "",
    "**Evidence:**",
    ...anomaly.evidence.map(e => `- ${e}`),
    "",
    `**Suggested action:** ${anomaly.suggestedAction}`,
  ].join("\n");
}
