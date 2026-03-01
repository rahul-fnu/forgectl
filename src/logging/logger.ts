import chalk from "chalk";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  phase: string;
  message: string;
  data?: Record<string, unknown>;
}

export class Logger {
  private entries: LogEntry[] = [];
  private verbose: boolean;
  private listeners: Array<(entry: LogEntry) => void> = [];

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  private emit(level: LogLevel, phase: string, message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      phase,
      message,
      data,
    };
    this.entries.push(entry);
    for (const listener of this.listeners) listener(entry);
  }

  debug(phase: string, message: string, data?: Record<string, unknown>): void {
    this.emit("debug", phase, message, data);
    if (this.verbose) console.log(chalk.gray(`  [${phase}] ${message}`));
  }

  info(phase: string, message: string, data?: Record<string, unknown>): void {
    this.emit("info", phase, message, data);
    console.log(chalk.cyan(`  [${phase}]`) + ` ${message}`);
  }

  warn(phase: string, message: string, data?: Record<string, unknown>): void {
    this.emit("warn", phase, message, data);
    console.log(chalk.yellow(`  ⚠ [${phase}]`) + ` ${message}`);
  }

  error(phase: string, message: string, data?: Record<string, unknown>): void {
    this.emit("error", phase, message, data);
    console.error(chalk.red(`  ✗ [${phase}]`) + ` ${message}`);
  }

  /** Subscribe to log events (for SSE streaming) */
  onEntry(fn: (entry: LogEntry) => void): void {
    this.listeners.push(fn);
  }

  /** Get all entries (for JSON run log) */
  getEntries(): LogEntry[] {
    return [...this.entries];
  }
}
