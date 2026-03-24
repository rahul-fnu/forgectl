import { and, eq, sql } from "drizzle-orm";
import { reviewMetrics } from "../schema.js";
import type { AppDatabase } from "../database.js";

export interface ReviewMetricRow {
  id: number;
  repo: string;
  prNumber: number;
  reviewRound: number;
  reviewCommentsCount: number;
  reviewMustFix: number;
  reviewShouldFix: number;
  reviewNit: number;
  reviewApprovedRound: number | null;
  reviewEscalated: boolean;
  finalOutcome: string | null;
  humanOverride: boolean;
  parseFailureCount: number;
  parseSuccessCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewMetricUpsertParams {
  repo: string;
  prNumber: number;
  reviewRound: number;
  reviewCommentsCount: number;
  reviewMustFix: number;
  reviewShouldFix: number;
  reviewNit: number;
  reviewApprovedRound?: number;
  reviewEscalated?: boolean;
  finalOutcome?: string;
  humanOverride?: boolean;
  parseFailureCount?: number;
  parseSuccessCount?: number;
}

export interface ReviewQualityStats {
  totalPRs: number;
  firstPassApprovalRate: number;
  averageReviewRounds: number;
  totalComments: number;
  totalMustFix: number;
  totalShouldFix: number;
  totalNit: number;
  escalatedCount: number;
  humanOverrideCount: number;
  estimatedFalsePositiveRate: number;
  parseFailureCount: number;
  parseSuccessCount: number;
  parseSuccessRate: number;
}

export interface ReviewMetricsRepository {
  upsert(params: ReviewMetricUpsertParams): void;
  updateOutcome(repo: string, prNumber: number, outcome: string): void;
  markHumanOverride(repo: string, prNumber: number): void;
  recordParseResult(repo: string, prNumber: number, success: boolean): void;
  findByPR(repo: string, prNumber: number): ReviewMetricRow[];
  findByRepo(repo: string): ReviewMetricRow[];
  findAll(): ReviewMetricRow[];
  computeStats(repo?: string): ReviewQualityStats;
}

function deserialize(raw: typeof reviewMetrics.$inferSelect): ReviewMetricRow {
  return {
    id: raw.id,
    repo: raw.repo,
    prNumber: raw.prNumber,
    reviewRound: raw.reviewRound,
    reviewCommentsCount: raw.reviewCommentsCount,
    reviewMustFix: raw.reviewMustFix,
    reviewShouldFix: raw.reviewShouldFix,
    reviewNit: raw.reviewNit,
    reviewApprovedRound: raw.reviewApprovedRound,
    reviewEscalated: raw.reviewEscalated === 1,
    finalOutcome: raw.finalOutcome,
    humanOverride: raw.humanOverride === 1,
    parseFailureCount: raw.parseFailureCount,
    parseSuccessCount: raw.parseSuccessCount,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export function createReviewMetricsRepository(db: AppDatabase): ReviewMetricsRepository {
  return {
    upsert(params: ReviewMetricUpsertParams): void {
      const now = new Date().toISOString();
      const existing = db
        .select()
        .from(reviewMetrics)
        .where(
          and(
            eq(reviewMetrics.repo, params.repo),
            eq(reviewMetrics.prNumber, params.prNumber),
            eq(reviewMetrics.reviewRound, params.reviewRound),
          ),
        )
        .get();

      if (existing) {
        db.update(reviewMetrics)
          .set({
            reviewCommentsCount: params.reviewCommentsCount,
            reviewMustFix: params.reviewMustFix,
            reviewShouldFix: params.reviewShouldFix,
            reviewNit: params.reviewNit,
            reviewApprovedRound: params.reviewApprovedRound ?? existing.reviewApprovedRound,
            reviewEscalated: params.reviewEscalated ? 1 : (existing.reviewEscalated ?? 0),
            finalOutcome: params.finalOutcome ?? existing.finalOutcome,
            humanOverride: params.humanOverride ? 1 : (existing.humanOverride ?? 0),
            parseFailureCount: (params.parseFailureCount ?? 0) + existing.parseFailureCount,
            parseSuccessCount: (params.parseSuccessCount ?? 0) + existing.parseSuccessCount,
            updatedAt: now,
          })
          .where(eq(reviewMetrics.id, existing.id))
          .run();
      } else {
        db.insert(reviewMetrics)
          .values({
            repo: params.repo,
            prNumber: params.prNumber,
            reviewRound: params.reviewRound,
            reviewCommentsCount: params.reviewCommentsCount,
            reviewMustFix: params.reviewMustFix,
            reviewShouldFix: params.reviewShouldFix,
            reviewNit: params.reviewNit,
            reviewApprovedRound: params.reviewApprovedRound ?? null,
            reviewEscalated: params.reviewEscalated ? 1 : 0,
            finalOutcome: params.finalOutcome ?? null,
            humanOverride: params.humanOverride ? 1 : 0,
            parseFailureCount: params.parseFailureCount ?? 0,
            parseSuccessCount: params.parseSuccessCount ?? 0,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
    },

    updateOutcome(repo: string, prNumber: number, outcome: string): void {
      const now = new Date().toISOString();
      db.update(reviewMetrics)
        .set({ finalOutcome: outcome, updatedAt: now })
        .where(
          and(
            eq(reviewMetrics.repo, repo),
            eq(reviewMetrics.prNumber, prNumber),
          ),
        )
        .run();
    },

    markHumanOverride(repo: string, prNumber: number): void {
      const now = new Date().toISOString();
      db.update(reviewMetrics)
        .set({ humanOverride: 1, updatedAt: now })
        .where(
          and(
            eq(reviewMetrics.repo, repo),
            eq(reviewMetrics.prNumber, prNumber),
          ),
        )
        .run();
    },

    recordParseResult(repo: string, prNumber: number, success: boolean): void {
      const now = new Date().toISOString();
      const existing = db
        .select()
        .from(reviewMetrics)
        .where(
          and(
            eq(reviewMetrics.repo, repo),
            eq(reviewMetrics.prNumber, prNumber),
          ),
        )
        .get();

      if (existing) {
        const updates = success
          ? { parseSuccessCount: existing.parseSuccessCount + 1, updatedAt: now }
          : { parseFailureCount: existing.parseFailureCount + 1, updatedAt: now };
        db.update(reviewMetrics)
          .set(updates)
          .where(eq(reviewMetrics.id, existing.id))
          .run();
      }
      // Don't create new metric rows for parse-only results to avoid inflating totalPRs count
    },

    findByPR(repo: string, prNumber: number): ReviewMetricRow[] {
      return db
        .select()
        .from(reviewMetrics)
        .where(
          and(
            eq(reviewMetrics.repo, repo),
            eq(reviewMetrics.prNumber, prNumber),
          ),
        )
        .all()
        .map(deserialize);
    },

    findByRepo(repo: string): ReviewMetricRow[] {
      return db
        .select()
        .from(reviewMetrics)
        .where(eq(reviewMetrics.repo, repo))
        .all()
        .map(deserialize);
    },

    findAll(): ReviewMetricRow[] {
      return db.select().from(reviewMetrics).all().map(deserialize);
    },

    computeStats(repo?: string): ReviewQualityStats {
      const rows = repo ? this.findByRepo(repo) : this.findAll();
      if (rows.length === 0) {
        return {
          totalPRs: 0,
          firstPassApprovalRate: 0,
          averageReviewRounds: 0,
          totalComments: 0,
          totalMustFix: 0,
          totalShouldFix: 0,
          totalNit: 0,
          escalatedCount: 0,
          humanOverrideCount: 0,
          estimatedFalsePositiveRate: 0,
          parseFailureCount: 0,
          parseSuccessCount: 0,
          parseSuccessRate: 0,
        };
      }

      const prMap = new Map<string, ReviewMetricRow[]>();
      for (const row of rows) {
        const key = `${row.repo}#${row.prNumber}`;
        const existing = prMap.get(key) ?? [];
        existing.push(row);
        prMap.set(key, existing);
      }

      const totalPRs = prMap.size;
      let firstPassApprovals = 0;
      let totalRounds = 0;
      let totalComments = 0;
      let totalMustFix = 0;
      let totalShouldFix = 0;
      let totalNit = 0;
      let escalatedCount = 0;
      let humanOverrideCount = 0;
      let parseFailureCount = 0;
      let parseSuccessCount = 0;

      for (const [, prRows] of prMap) {
        const maxRound = Math.max(...prRows.map(r => r.reviewRound));
        totalRounds += maxRound;

        for (const r of prRows) {
          totalComments += r.reviewCommentsCount;
          totalMustFix += r.reviewMustFix;
          totalShouldFix += r.reviewShouldFix;
          totalNit += r.reviewNit;
        }

        const firstRound = prRows.find(r => r.reviewRound === 1);
        if (firstRound && firstRound.reviewApprovedRound === 1) {
          firstPassApprovals++;
        }

        for (const r of prRows) {
          parseFailureCount += r.parseFailureCount;
          parseSuccessCount += r.parseSuccessCount;
        }

        if (prRows.some(r => r.reviewEscalated)) escalatedCount++;
        if (prRows.some(r => r.humanOverride)) humanOverrideCount++;
      }

      const requestChangesCount = rows.filter(r => r.reviewMustFix > 0 || r.reviewShouldFix > 0).length;
      const estimatedFalsePositiveRate = requestChangesCount > 0
        ? humanOverrideCount / requestChangesCount
        : 0;

      return {
        totalPRs,
        firstPassApprovalRate: totalPRs > 0 ? firstPassApprovals / totalPRs : 0,
        averageReviewRounds: totalPRs > 0 ? totalRounds / totalPRs : 0,
        totalComments,
        totalMustFix,
        totalShouldFix,
        totalNit,
        escalatedCount,
        humanOverrideCount,
        estimatedFalsePositiveRate,
        parseFailureCount,
        parseSuccessCount,
        parseSuccessRate: (parseFailureCount + parseSuccessCount) > 0
          ? parseSuccessCount / (parseFailureCount + parseSuccessCount)
          : 0,
      };
    },
  };
}
