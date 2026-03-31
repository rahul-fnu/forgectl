import { eq, and, sql } from "drizzle-orm";
import { reviewFindings, reviewCalibration } from "../schema.js";
import type { AppDatabase } from "../database.js";

export interface ReviewFindingRow {
  id: number;
  category: string;
  pattern: string;
  module: string;
  occurrenceCount: number;
  firstSeen: string;
  lastSeen: string;
  promotedToConvention: boolean;
  exampleComment: string | null;
}

export interface ReviewFindingUpsertParams {
  category: string;
  pattern: string;
  module: string;
  exampleComment?: string;
}

export interface CalibrationRow {
  id: number;
  module: string;
  totalComments: number;
  overriddenComments: number;
  falsePositiveRate: number;
  lastUpdated: string;
}

export interface ReviewFindingsRepository {
  upsertFinding(params: ReviewFindingUpsertParams): void;
  getPromotedFindings(): ReviewFindingRow[];
  getPromotedFindingsForModules(modules: string[]): ReviewFindingRow[];
  promoteEligible(threshold?: number): number;
  findAll(): ReviewFindingRow[];
  recordCalibration(module: string, total: number, overridden: number): void;
  getCalibration(module: string): CalibrationRow | undefined;
  getAllCalibration(): CalibrationRow[];
  getMiscalibratedModules(threshold?: number): CalibrationRow[];
}

const PROMOTION_THRESHOLD = 3;
const FALSE_POSITIVE_THRESHOLD = 0.3;

function deserializeFinding(raw: typeof reviewFindings.$inferSelect): ReviewFindingRow {
  return {
    id: raw.id,
    category: raw.category,
    pattern: raw.pattern,
    module: raw.module,
    occurrenceCount: raw.occurrenceCount,
    firstSeen: raw.firstSeen,
    lastSeen: raw.lastSeen,
    promotedToConvention: raw.promotedToConvention === 1,
    exampleComment: raw.exampleComment,
  };
}

function deserializeCalibration(raw: typeof reviewCalibration.$inferSelect): CalibrationRow {
  return {
    id: raw.id,
    module: raw.module,
    totalComments: raw.totalComments,
    overriddenComments: raw.overriddenComments,
    falsePositiveRate: raw.falsePositiveRate,
    lastUpdated: raw.lastUpdated,
  };
}

export function createReviewFindingsRepository(db: AppDatabase): ReviewFindingsRepository {
  return {
    upsertFinding(params: ReviewFindingUpsertParams): void {
      const now = new Date().toISOString();
      const existing = db
        .select()
        .from(reviewFindings)
        .where(
          and(
            eq(reviewFindings.category, params.category),
            eq(reviewFindings.pattern, params.pattern),
            eq(reviewFindings.module, params.module),
          ),
        )
        .get();

      if (existing) {
        db.update(reviewFindings)
          .set({
            occurrenceCount: existing.occurrenceCount + 1,
            lastSeen: now,
            exampleComment: params.exampleComment ?? existing.exampleComment,
          })
          .where(eq(reviewFindings.id, existing.id))
          .run();
      } else {
        db.insert(reviewFindings)
          .values({
            category: params.category,
            pattern: params.pattern,
            module: params.module,
            occurrenceCount: 1,
            firstSeen: now,
            lastSeen: now,
            promotedToConvention: 0,
            exampleComment: params.exampleComment ?? null,
          })
          .run();
      }
    },

    getPromotedFindings(): ReviewFindingRow[] {
      return db
        .select()
        .from(reviewFindings)
        .where(eq(reviewFindings.promotedToConvention, 1))
        .all()
        .map(deserializeFinding);
    },

    getPromotedFindingsForModules(modules: string[]): ReviewFindingRow[] {
      if (modules.length === 0) return this.getPromotedFindings();
      return db
        .select()
        .from(reviewFindings)
        .where(eq(reviewFindings.promotedToConvention, 1))
        .all()
        .map(deserializeFinding)
        .filter((f) => modules.includes(f.module) || f.module === "*");
    },

    promoteEligible(threshold?: number): number {
      const minCount = threshold ?? PROMOTION_THRESHOLD;
      const result = db
        .update(reviewFindings)
        .set({ promotedToConvention: 1 })
        .where(
          and(
            sql`${reviewFindings.occurrenceCount} >= ${minCount}`,
            eq(reviewFindings.promotedToConvention, 0),
          ),
        )
        .run();
      return result.changes;
    },

    findAll(): ReviewFindingRow[] {
      return db.select().from(reviewFindings).all().map(deserializeFinding);
    },

    recordCalibration(module: string, total: number, overridden: number): void {
      const now = new Date().toISOString();
      const rate = total > 0 ? overridden / total : 0;
      const existing = db
        .select()
        .from(reviewCalibration)
        .where(eq(reviewCalibration.module, module))
        .get();

      if (existing) {
        const newTotal = existing.totalComments + total;
        const newOverridden = existing.overriddenComments + overridden;
        const newRate = newTotal > 0 ? newOverridden / newTotal : 0;
        db.update(reviewCalibration)
          .set({
            totalComments: newTotal,
            overriddenComments: newOverridden,
            falsePositiveRate: newRate,
            lastUpdated: now,
          })
          .where(eq(reviewCalibration.id, existing.id))
          .run();
      } else {
        db.insert(reviewCalibration)
          .values({
            module,
            totalComments: total,
            overriddenComments: overridden,
            falsePositiveRate: rate,
            lastUpdated: now,
          })
          .run();
      }
    },

    getCalibration(module: string): CalibrationRow | undefined {
      const row = db
        .select()
        .from(reviewCalibration)
        .where(eq(reviewCalibration.module, module))
        .get();
      return row ? deserializeCalibration(row) : undefined;
    },

    getAllCalibration(): CalibrationRow[] {
      return db
        .select()
        .from(reviewCalibration)
        .all()
        .map(deserializeCalibration);
    },

    getMiscalibratedModules(threshold?: number): CalibrationRow[] {
      const maxRate = threshold ?? FALSE_POSITIVE_THRESHOLD;
      return db
        .select()
        .from(reviewCalibration)
        .all()
        .map(deserializeCalibration)
        .filter((c) => c.falsePositiveRate > maxRate && c.totalComments > 0);
    },
  };
}
