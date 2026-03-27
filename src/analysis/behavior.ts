import type { EventRow } from "../storage/repositories/events.js";
import type { CostSummary } from "../storage/repositories/costs.js";

const TRACKED_TOOLS = new Set(["Read", "Write", "Bash", "Edit", "Grep", "Glob"]);

export interface ToolUsageEntry {
  tool: string;
  count: number;
  pct: number;
}

export interface ToolUsageReport {
  totalCalls: number;
  byTool: ToolUsageEntry[];
}

export interface FailureSignature {
  signature: string;
  count: number;
  runIds: string[];
}

export interface TokenWasteReport {
  totalTokens: number;
  wastedTokens: number;
  wasteRatio: number;
  revertedSegments: number;
}

export interface StuckPoint {
  runId: string;
  eventIndex: number;
  type: string;
  timestamp: string;
  durationMs: number;
}

export function extractToolUsage(events: EventRow[]): ToolUsageReport {
  const counts = new Map<string, number>();
  let totalCalls = 0;

  for (const e of events) {
    if (e.type !== "tool_use") continue;
    const data = e.data as Record<string, unknown> | null;
    const tool = data?.tool as string | undefined;
    if (!tool || !TRACKED_TOOLS.has(tool)) continue;
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
    totalCalls++;
  }

  const byTool: ToolUsageEntry[] = Array.from(counts.entries())
    .map(([tool, count]) => ({
      tool,
      count,
      pct: totalCalls > 0 ? count / totalCalls : 0,
    }))
    .sort((a, b) => b.count - a.count);

  return { totalCalls, byTool };
}

export function extractFailurePatterns(events: EventRow[]): FailureSignature[] {
  const sigMap = new Map<string, { count: number; runIds: Set<string> }>();

  for (const e of events) {
    if (e.type !== "failed" && e.type !== "validation_step") continue;
    const data = e.data as Record<string, unknown> | null;

    let signature: string;
    if (e.type === "failed") {
      const error = (data?.error as string) ?? (data?.reason as string) ?? "unknown";
      signature = `failed:${error}`;
    } else {
      const passed = data?.passed ?? data?.success;
      if (passed) continue;
      const step = (data?.step as string) ?? (data?.name as string) ?? "unknown";
      signature = `validation:${step}`;
    }

    const entry = sigMap.get(signature) ?? { count: 0, runIds: new Set() };
    entry.count++;
    entry.runIds.add(e.runId);
    sigMap.set(signature, entry);
  }

  return Array.from(sigMap.entries())
    .map(([signature, { count, runIds }]) => ({
      signature,
      count,
      runIds: Array.from(runIds),
    }))
    .sort((a, b) => b.count - a.count);
}

export function detectTokenWaste(events: EventRow[], costs: CostSummary): TokenWasteReport {
  const totalTokens = costs.totalInputTokens + costs.totalOutputTokens;

  let retryCount = 0;
  let revertedSegments = 0;

  for (const e of events) {
    if (e.type === "retry") {
      retryCount++;
    }
    if (e.type === "loop_detected") {
      revertedSegments++;
    }
  }

  const totalEvents = events.length;
  const retryRatio = totalEvents > 0 ? retryCount / totalEvents : 0;
  const wastedTokens = Math.round(totalTokens * retryRatio);
  const wasteRatio = totalTokens > 0 ? wastedTokens / totalTokens : 0;

  return {
    totalTokens,
    wastedTokens,
    wasteRatio: Math.round(wasteRatio * 10000) / 10000,
    revertedSegments,
  };
}

export function getStuckPoints(events: EventRow[]): StuckPoint[] {
  if (events.length < 2) return [];

  const sorted = [...events].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const gaps: Array<{ index: number; event: EventRow; durationMs: number }> = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1].timestamp).getTime();
    const curr = new Date(sorted[i].timestamp).getTime();
    const durationMs = curr - prev;
    gaps.push({ index: i, event: sorted[i], durationMs });
  }

  if (gaps.length === 0) return [];

  const totalDurationMs = gaps.reduce((sum, g) => sum + g.durationMs, 0);
  const avgGapMs = totalDurationMs / gaps.length;
  const threshold = Math.max(avgGapMs * 3, 1000);

  return gaps
    .filter((g) => g.durationMs > threshold)
    .map((g) => ({
      runId: g.event.runId,
      eventIndex: g.index,
      type: g.event.type,
      timestamp: g.event.timestamp,
      durationMs: g.durationMs,
    }))
    .sort((a, b) => b.durationMs - a.durationMs);
}
