import { execFileSync } from "node:child_process";
import type { TrackerIssue } from "../tracker/types.js";
import type { OrchestratorState } from "./state.js";
import type { ForgectlConfig } from "../config/schema.js";

export type TriageComplexity = "low" | "medium" | "high";

export interface ComplexityAssessment {
  complexityScore: number; // 1-10
  estimatedFiles: number;
  estimatedEffort: "trivial" | "simple" | "moderate" | "complex" | "epic";
  riskFactors: string[];
  recommendation: "dispatch" | "split" | "human_review";
}

export interface TriageResult {
  shouldDispatch: boolean;
  reason: string;
  complexity?: TriageComplexity;
  assessment?: ComplexityAssessment;
  duplicateOf?: string;
}

/**
 * Estimate issue complexity from title + description heuristics.
 * Uses text length, file reference count, and keyword signals.
 */
export function estimateComplexity(issue: TrackerIssue): TriageComplexity {
  const text = `${issue.title}\n${issue.description}`;
  const len = text.length;

  const fileRefPattern = /(?:src|test|lib|packages?)\/[\w/.=-]+\.(?:ts|js|tsx|jsx|py|rs|go)/g;
  const fileRefs = (text.match(fileRefPattern) ?? []).length;

  const highSignals = /\b(breaking change|migration|redesign|refactor.*across|cross[- ]?cutting|architectural)\b/i;
  if (highSignals.test(text) || fileRefs >= 8 || len > 4000) {
    return "high";
  }

  const lowSignals = /\b(typo|rename|bump|update dep|fix import|lint|format|nit)\b/i;
  if (lowSignals.test(text) && fileRefs <= 2 && len < 800) {
    return "low";
  }

  if (fileRefs <= 3 && len < 1500) {
    return "low";
  }

  return "medium";
}

function heuristicAssessment(issue: TrackerIssue): ComplexityAssessment {
  const complexity = estimateComplexity(issue);
  const text = `${issue.title}\n${issue.description}`;
  const fileRefPattern = /(?:src|test|lib|packages?)\/[\w/.=-]+\.(?:ts|js|tsx|jsx|py|rs|go)/g;
  const fileRefs = (text.match(fileRefPattern) ?? []).length;

  const scoreMap: Record<TriageComplexity, number> = { low: 2, medium: 5, high: 8 };
  const effortMap: Record<TriageComplexity, ComplexityAssessment["estimatedEffort"]> = {
    low: "simple",
    medium: "moderate",
    high: "complex",
  };
  const recoMap: Record<TriageComplexity, ComplexityAssessment["recommendation"]> = {
    low: "dispatch",
    medium: "dispatch",
    high: "split",
  };

  return {
    complexityScore: scoreMap[complexity],
    estimatedFiles: Math.max(fileRefs, 1),
    estimatedEffort: effortMap[complexity],
    riskFactors: complexity === "high" ? ["high heuristic complexity"] : [],
    recommendation: recoMap[complexity],
  };
}

export async function assessComplexity(
  issue: TrackerIssue,
  kgContext?: string,
): Promise<ComplexityAssessment> {
  const prompt = [
    "You are a software complexity estimator. Respond ONLY with valid JSON, no markdown fences.",
    "",
    `Issue title: ${issue.title}`,
    `Issue description: ${issue.description}`,
    kgContext ? `\nKnowledge graph context (files in scope):\n${kgContext}` : "",
    "",
    "Return a JSON object with these exact fields:",
    '- complexityScore: number 1-10 (1=trivial, 10=massive)',
    "- estimatedFiles: number of files likely to be modified",
    '- estimatedEffort: one of "trivial", "simple", "moderate", "complex", "epic"',
    "- riskFactors: array of strings describing risks",
    '- recommendation: one of "dispatch", "split", "human_review"',
  ].join("\n");

  try {
    const stdout = execFileSync(
      "claude",
      ["-p", prompt, "--model", "claude-haiku-4-5-20251001", "--output-format", "json"],
      { timeout: 15_000, stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" },
    );

    const parsed = JSON.parse(extractJSON(stdout));
    return validateAssessment(parsed);
  } catch {
    return heuristicAssessment(issue);
  }
}

function extractJSON(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    return trimmed.slice(braceStart, braceEnd + 1);
  }
  return trimmed;
}

function validateAssessment(raw: unknown): ComplexityAssessment {
  const obj = raw as Record<string, unknown>;
  const score = Number(obj.complexityScore);
  if (!Number.isInteger(score) || score < 1 || score > 10) {
    throw new Error("invalid complexityScore");
  }
  const files = Number(obj.estimatedFiles);
  if (!Number.isFinite(files) || files < 0) {
    throw new Error("invalid estimatedFiles");
  }
  const validEfforts = ["trivial", "simple", "moderate", "complex", "epic"] as const;
  if (!validEfforts.includes(obj.estimatedEffort as typeof validEfforts[number])) {
    throw new Error("invalid estimatedEffort");
  }
  const validRecos = ["dispatch", "split", "human_review"] as const;
  if (!validRecos.includes(obj.recommendation as typeof validRecos[number])) {
    throw new Error("invalid recommendation");
  }
  const riskFactors = Array.isArray(obj.riskFactors)
    ? obj.riskFactors.filter((r): r is string => typeof r === "string")
    : [];

  return {
    complexityScore: score,
    estimatedFiles: Math.round(files),
    estimatedEffort: obj.estimatedEffort as ComplexityAssessment["estimatedEffort"],
    riskFactors,
    recommendation: obj.recommendation as ComplexityAssessment["recommendation"],
  };
}

/**
 * Fast pre-dispatch filtering to avoid wasting agent time.
 * Checks for duplicate titles against running issues, recently completed issues,
 * and estimates complexity.
 */
export async function triageIssue(
  issue: TrackerIssue,
  state: OrchestratorState,
  config: ForgectlConfig,
): Promise<TriageResult> {
  if (!config.orchestrator.enable_triage) {
    return { shouldDispatch: true, reason: "triage disabled" };
  }

  // Duplicate check: compare title against running issues
  const normalizedTitle = issue.title.trim().toLowerCase();
  for (const [, worker] of state.running) {
    if (worker.issue.id === issue.id) continue;
    const runningTitle = worker.issue.title.trim().toLowerCase();
    if (runningTitle === normalizedTitle) {
      return {
        shouldDispatch: false,
        reason: `duplicate of running issue ${worker.identifier}`,
        duplicateOf: worker.issueId,
      };
    }
  }

  if (state.recentlyCompleted.has(issue.id)) {
    return {
      shouldDispatch: false,
      reason: "issue recently completed",
    };
  }

  const complexity = estimateComplexity(issue);
  const assessment = await assessComplexity(issue);

  if (assessment.complexityScore > config.orchestrator.triage_max_complexity) {
    return {
      shouldDispatch: false,
      reason: `complexity score ${assessment.complexityScore} exceeds max ${config.orchestrator.triage_max_complexity}`,
      complexity,
      assessment,
    };
  }

  return { shouldDispatch: true, reason: "passed triage", complexity, assessment };
}
