import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EventRepository, EventRow } from "../storage/repositories/events.js";
import type { CostRepository, CostSummary } from "../storage/repositories/costs.js";
import type { RunSummary } from "../storage/repositories/runs.js";

export type { RunSummary };

const KEY_EVENT_TYPES = new Set([
  "started",
  "validation_step",
  "retry",
  "loop_detected",
  "escalation",
  "completed",
  "failed",
]);

export function filterKeyEvents(events: EventRow[]): EventRow[] {
  return events.filter((e) => KEY_EVENT_TYPES.has(e.type));
}

export function buildPromptText(keyEvents: EventRow[], costSummary: CostSummary): string {
  const eventLog = keyEvents
    .map((e) => {
      const dataStr = e.data ? ` ${JSON.stringify(e.data)}` : "";
      return `[${e.timestamp}] ${e.type}${dataStr}`;
    })
    .join("\n");

  return `You are analyzing a forgectl agent run. Given the event log and cost data below, produce a JSON object with exactly these 6 string fields:

- "approach": 1-2 sentences on what strategy the agent took
- "keyActions": files created/modified, core changes made
- "obstacles": where did it get stuck, what errors occurred
- "retries": how many validation cycles, what changed between attempts
- "outcome": final result and why
- "tokenEfficiency": cost analysis, wasted tokens on failed approaches

Event log:
${eventLog}

Cost data:
- Input tokens: ${costSummary.totalInputTokens}
- Output tokens: ${costSummary.totalOutputTokens}
- Total cost USD: $${costSummary.totalCostUsd.toFixed(4)}

Respond with ONLY the JSON object, no markdown fences or extra text.`;
}

export async function generateRunSummary(
  runId: string,
  eventRepo: EventRepository,
  costRepo: CostRepository,
): Promise<RunSummary> {
  const events = eventRepo.findByRunId(runId);
  const costSummary = costRepo.sumByRunId(runId);
  const keyEvents = filterKeyEvents(events);
  const promptText = buildPromptText(keyEvents, costSummary);

  const promptFile = join(tmpdir(), `forgectl-summary-${runId}.txt`);
  try {
    writeFileSync(promptFile, promptText);
    const output = execFileSync("claude", [
      "--model", "claude-haiku-4-5-20251001",
      "-p", promptFile,
      "--output-format", "json",
      "--max-turns", "1",
    ], { encoding: "utf-8", timeout: 30_000 });

    const parsed = JSON.parse(output);
    return {
      approach: String(parsed.approach ?? ""),
      keyActions: String(parsed.keyActions ?? ""),
      obstacles: String(parsed.obstacles ?? ""),
      retries: String(parsed.retries ?? ""),
      outcome: String(parsed.outcome ?? ""),
      tokenEfficiency: String(parsed.tokenEfficiency ?? ""),
    };
  } finally {
    try { unlinkSync(promptFile); } catch { /* best-effort cleanup */ }
  }
}
