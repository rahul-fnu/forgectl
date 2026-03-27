import chalk from "chalk";
import { createDatabase, closeDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/migrator.js";
import { createTraceRepository } from "../storage/repositories/traces.js";
import type { SpanRow } from "../storage/repositories/traces.js";

export interface WaterfallLine {
  indent: number;
  operationName: string;
  durationMs: number;
  bar: string;
  offsetMs: number;
}

export function buildWaterfallLines(spans: SpanRow[]): WaterfallLine[] {
  if (spans.length === 0) return [];

  const traceStartMs = spans[0].startMs;
  const traceEndMs = Math.max(...spans.map((s) => s.startMs + s.durationMs));
  const totalMs = traceEndMs - traceStartMs || 1;
  const barWidth = 40;

  const childrenMap = new Map<string | null, SpanRow[]>();
  for (const span of spans) {
    const key = span.parentSpanId;
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key)!.push(span);
  }

  const lines: WaterfallLine[] = [];

  function walk(parentId: string | null, depth: number) {
    const children = childrenMap.get(parentId) ?? [];
    for (const span of children) {
      const offsetMs = span.startMs - traceStartMs;
      const startPos = Math.round((offsetMs / totalMs) * barWidth);
      const width = Math.max(1, Math.round((span.durationMs / totalMs) * barWidth));
      const bar = " ".repeat(startPos) + "█".repeat(width);

      lines.push({
        indent: depth,
        operationName: span.operationName,
        durationMs: span.durationMs,
        bar,
        offsetMs,
      });
      walk(span.spanId, depth + 1);
    }
  }

  walk(null, 0);

  // If no root spans found (all have parentSpanId), fall back to flat list
  if (lines.length === 0) {
    for (const span of spans) {
      const offsetMs = span.startMs - traceStartMs;
      const startPos = Math.round((offsetMs / totalMs) * barWidth);
      const width = Math.max(1, Math.round((span.durationMs / totalMs) * barWidth));
      const bar = " ".repeat(startPos) + "█".repeat(width);

      lines.push({
        indent: 0,
        operationName: span.operationName,
        durationMs: span.durationMs,
        bar,
        offsetMs,
      });
    }
  }

  return lines;
}

export function formatWaterfall(lines: WaterfallLine[]): string {
  if (lines.length === 0) return "No spans found";

  const output: string[] = [];
  for (const line of lines) {
    const prefix = "  ".repeat(line.indent);
    const name = `${prefix}${line.operationName}`.padEnd(30);
    const dur = `${line.durationMs}ms`.padStart(8);
    output.push(`${name} ${dur}  |${line.bar}|`);
  }
  return output.join("\n");
}

export async function traceCommand(runId: string): Promise<void> {
  const db = createDatabase();
  try {
    runMigrations(db);

    const traceRepo = createTraceRepository(db);
    const spans = traceRepo.findByTraceId(runId);

    if (spans.length === 0) {
      console.error(chalk.red(`No trace found for: ${runId}`));
      process.exit(1);
    }

    console.log(chalk.bold(`\nTrace: ${runId}\n`));

    const lines = buildWaterfallLines(spans);
    console.log(formatWaterfall(lines));
    console.log("");
  } finally {
    closeDatabase(db);
  }
}
