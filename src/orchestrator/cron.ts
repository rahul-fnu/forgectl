// Simple 5-field cron expression evaluator.
// Fields: minute hour day-of-month month day-of-week
// Supports: numbers, wildcards, ranges (1-5), steps, lists (1,3,5)

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepParts = part.split("/");
    const rangePart = stepParts[0];
    const step = stepParts.length > 1 ? parseInt(stepParts[1], 10) : 1;
    if (isNaN(step) || step < 1) throw new Error(`Invalid step in cron field: ${field}`);

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [lo, hi] = rangePart.split("-").map(Number);
      if (isNaN(lo) || isNaN(hi)) throw new Error(`Invalid range in cron field: ${field}`);
      start = lo;
      end = hi;
    } else {
      const val = parseInt(rangePart, 10);
      if (isNaN(val)) throw new Error(`Invalid value in cron field: ${field}`);
      if (stepParts.length > 1) {
        start = val;
        end = max;
      } else {
        values.add(val);
        continue;
      }
    }

    for (let i = start; i <= end; i += step) {
      values.add(i);
    }
  }
  return values;
}

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have 5 fields, got ${parts.length}: "${expression}"`);
  }
  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    daysOfMonth: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    daysOfWeek: parseField(parts[4], 0, 6),
  };
}

export function cronMatches(fields: CronFields, date: Date): boolean {
  return (
    fields.minutes.has(date.getMinutes()) &&
    fields.hours.has(date.getHours()) &&
    fields.daysOfMonth.has(date.getDate()) &&
    fields.months.has(date.getMonth() + 1) &&
    fields.daysOfWeek.has(date.getDay())
  );
}
