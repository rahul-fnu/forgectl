import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LogEntry } from "./logger.js";

export interface RunLog {
  runId: string;
  task: string;
  workflow: string;
  agent: string;
  status: "success" | "failed" | "abandoned";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  validation: {
    attempts: number;
    steps: Array<{
      name: string;
      passed: boolean;
      attempts: number;
    }>;
  };
  output: {
    mode: "git" | "files";
    branch?: string;
    dir?: string;
    files?: string[];
  };
  entries: LogEntry[];
}

export function saveRunLog(log: RunLog, logDir: string): string {
  const dir = resolve(logDir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${log.runId}.json`);
  writeFileSync(filePath, JSON.stringify(log, null, 2));
  return filePath;
}
