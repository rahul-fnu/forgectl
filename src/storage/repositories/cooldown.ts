import { eq } from "drizzle-orm";
import { cooldownState } from "../schema.js";
import type { AppDatabase } from "../database.js";

export interface CooldownState {
  active: boolean;
  enteredAt: string | null;
  resumeAt: string | null;
  probeCount: number;
}

export interface CooldownRepository {
  getCooldownState(): CooldownState | null;
  enterCooldown(resumeAt: string): void;
  exitCooldown(): void;
  incrementProbeCount(): void;
}

export function createCooldownRepository(db: AppDatabase): CooldownRepository {
  return {
    getCooldownState(): CooldownState | null {
      const row = db.select().from(cooldownState).where(eq(cooldownState.id, 1)).get();
      if (!row) return null;
      return {
        active: row.active === 1,
        enteredAt: row.enteredAt,
        resumeAt: row.resumeAt,
        probeCount: row.probeCount ?? 0,
      };
    },

    enterCooldown(resumeAt: string): void {
      const existing = db.select().from(cooldownState).where(eq(cooldownState.id, 1)).get();
      if (existing) {
        db.update(cooldownState)
          .set({ active: 1, enteredAt: new Date().toISOString(), resumeAt, probeCount: 0 })
          .where(eq(cooldownState.id, 1))
          .run();
      } else {
        db.insert(cooldownState)
          .values({ id: 1, active: 1, enteredAt: new Date().toISOString(), resumeAt, probeCount: 0 })
          .run();
      }
    },

    exitCooldown(): void {
      const existing = db.select().from(cooldownState).where(eq(cooldownState.id, 1)).get();
      if (existing) {
        db.update(cooldownState)
          .set({ active: 0, enteredAt: null, resumeAt: null, probeCount: 0 })
          .where(eq(cooldownState.id, 1))
          .run();
      }
    },

    incrementProbeCount(): void {
      const existing = db.select().from(cooldownState).where(eq(cooldownState.id, 1)).get();
      if (existing) {
        db.update(cooldownState)
          .set({ probeCount: (existing.probeCount ?? 0) + 1 })
          .where(eq(cooldownState.id, 1))
          .run();
      }
    },
  };
}
