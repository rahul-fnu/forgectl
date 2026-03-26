export interface UsageLimitDetectorConfig {
  enabled: boolean;
  patterns: string[];
  hangTimeoutMs?: number;
  exitCodes?: number[];
}

export interface DetectionResult {
  detected: boolean;
  reason: "pattern_match" | "hang_timeout" | "exit_code";
  matchedPattern?: string;
  rawOutput?: string;
  timestamp: string;
}

const DEFAULT_PATTERNS = [
  "usage limit",
  "rate limit",
  "capacity",
  "too many requests",
  "quota exceeded",
  "please try again later",
  "your account has reached",
];

export class UsageLimitDetector {
  private patterns: string[];

  constructor(private config: UsageLimitDetectorConfig) {
    this.patterns = config.patterns.length > 0 ? config.patterns : DEFAULT_PATTERNS;
  }

  checkOutput(output: string): DetectionResult | null {
    if (!this.config.enabled) return null;
    const lower = output.toLowerCase();
    for (const pattern of this.patterns) {
      if (lower.includes(pattern.toLowerCase())) {
        return {
          detected: true,
          reason: "pattern_match",
          matchedPattern: pattern,
          rawOutput: output.slice(0, 500),
          timestamp: new Date().toISOString(),
        };
      }
    }
    return null;
  }

  checkExitCode(code: number): DetectionResult | null {
    if (!this.config.enabled) return null;
    if (!this.config.exitCodes || this.config.exitCodes.length === 0) return null;
    if (this.config.exitCodes.includes(code)) {
      return {
        detected: true,
        reason: "exit_code",
        timestamp: new Date().toISOString(),
      };
    }
    return null;
  }

  checkHang(lastOutputAt: number): DetectionResult | null {
    if (!this.config.enabled) return null;
    if (!this.config.hangTimeoutMs) return null;
    const elapsed = Date.now() - lastOutputAt;
    if (elapsed >= this.config.hangTimeoutMs) {
      return {
        detected: true,
        reason: "hang_timeout",
        timestamp: new Date().toISOString(),
      };
    }
    return null;
  }
}
