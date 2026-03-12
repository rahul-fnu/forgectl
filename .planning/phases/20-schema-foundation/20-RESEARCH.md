# Phase 20: Schema Foundation - Research

**Researched:** 2026-03-12
**Domain:** SQLite schema migration (Drizzle ORM), TypeScript type extension (Zod + interfaces), third-party expression evaluator (filtrex)
**Confidence:** HIGH

## Summary

Phase 20 is a pure foundation phase: no behavioral change, no new CLI commands. It installs filtrex, extends the `runs` SQLite table with 5 delegation-related columns, creates a new `delegations` table with a typed Drizzle repository, and extends `PipelineNode` types and Zod schemas with `node_type`, `condition`, and `loop` fields.

The codebase has a clean, well-established pattern for all three workstreams. All 5 existing Drizzle migrations use `ALTER TABLE ... ADD` for additive changes to `runs` and `CREATE TABLE` + `CREATE INDEX` for new tables. The four existing repositories all follow the same `createXRepository(db)` factory pattern with `Row` / `InsertParams` interfaces and a private `deserializeRow()` function. The pipeline parser uses a single `PipelineNodeSchema` zod object that is straightforward to extend.

**Primary recommendation:** Follow the established patterns exactly — new migration `0005_delegation_schema.sql`, new `src/storage/repositories/delegations.ts`, and surgical additions to `src/storage/schema.ts`, `src/pipeline/types.ts`, and `src/pipeline/parser.ts`. No new files anywhere else. All 1,021 tests must pass before this phase is done; the new schema/types are purely additive so they should not break any existing tests.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Delegations table design**
- One record per child task (not per delegation event or per manifest)
- Columns: id (INTEGER PK auto), parentRunId (TEXT FK → runs.id), childRunId (TEXT FK → runs.id), taskSpec (TEXT JSON), status (TEXT: pending/dispatched/completed/failed), result (TEXT JSON nullable), retryCount (INTEGER DEFAULT 0), lastError (TEXT nullable), createdAt (TEXT), completedAt (TEXT nullable)
- taskSpec JSON mirrors the delegation manifest format from DELEG-01: `{id, task, workflow?, agent?}` — clean round-trip from manifest → table → dispatcher
- Retry handling: same row updated in place — increment retryCount, update taskSpec with new instructions, assign new childRunId, reset status to 'dispatched'

**Delegation repository methods — Full query helpers (not minimal CRUD):**
- `insert(params)`
- `findById(id)`
- `findByParentRunId(parentRunId)` — Phase 23 waitForChildren
- `findByChildRunId(childRunId)` — child completion callback
- `updateStatus(id, status, result?)` — status transitions
- `countByParentAndStatus(parentRunId, status)` — slot budget enforcement
- `list()`

**PipelineNode condition fields**
- `condition` is a plain string (filtrex expression), not an object
- `else_node` is a separate optional string field (node ID for false-branch routing)
- `if_failed` and `if_passed` shorthand fields included in types now — Phase 21 implements the resolver

**PipelineNode loop field**
- `loop` is an object: `{ until: string, max_iterations?: number, body?: string[] }`
- `until` is a filtrex expression evaluated after each iteration
- `max_iterations` has a global safety cap enforced in code (YAML value cannot exceed it)
- `body` lists node IDs that form the loop body

**PipelineNode node_type enum**
- Three values: `'task' | 'condition' | 'loop'`
- Default is `'task'` (backward compatible — omitted in existing YAML)
- No `'delegation'` type

### Claude's Discretion
- Migration file naming/tag (next sequential: 0005_*)
- Exact Zod schema validation rules for new fields
- Whether to add indexes on delegations table (parentRunId, childRunId)
- filtrex import/re-export pattern
- Runs table column ordering in migration SQL

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| drizzle-orm | ^0.45.1 (already installed) | ORM + migration runner | Already used in project |
| drizzle-kit | ^0.31.9 (already installed) | Migration file generation tool | Already used in project |
| better-sqlite3 | ^12.6.2 (already installed) | SQLite driver | Already used in project |
| zod | ^3.23.0 (already installed) | Runtime schema validation | Already used in parser.ts |
| filtrex | ^3.1.0 (NEW — not yet in package.json) | Safe expression evaluator for condition/loop fields | Chosen by project decision; zero dependencies, MIT, bundles its own .d.ts type declarations |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| drizzle-orm/sqlite-core | (from drizzle-orm) | `sqliteTable`, `text`, `integer` table builders | Schema definition in schema.ts |
| drizzle-orm/better-sqlite3/migrator | (from drizzle-orm) | `migrate()` function | Only used in migrator.ts — already wired |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| filtrex ^3.1.0 | jexl, expr-eval, mathjs | filtrex locked by project decision; others offer no benefit for this phase |

**Installation (one new dependency):**
```bash
npm install filtrex@^3.1.0
```

No `@types/filtrex` needed — filtrex 3.1.0 bundles its own `.d.ts` files at `dist/esm/filtrex.d.ts` (confirmed via `npm pack --dry-run`). The package's `types` field in package.json points to `dist/esm/filtrex.d.ts`.

## Architecture Patterns

### Recommended Project Structure Changes
```
src/
├── storage/
│   ├── schema.ts              # ADD 5 columns to runs table + new delegations table definition
│   └── repositories/
│       └── delegations.ts     # NEW — DelegationRow, DelegationInsertParams, DelegationRepository, createDelegationRepository()
├── pipeline/
│   ├── types.ts               # ADD node_type, condition, else_node, if_failed, if_passed, loop fields to PipelineNode
│   └── parser.ts              # EXTEND PipelineNodeSchema with new optional fields
drizzle/
└── 0005_delegation_schema.sql # NEW — ALTER TABLE runs ADD + CREATE TABLE delegations + CREATE INDEX
```

### Pattern 1: Drizzle Schema Extension (runs table)
**What:** Add nullable columns to an existing table. Extend the Drizzle table definition in `schema.ts` and write a migration SQL file.
**When to use:** Additive column changes that must not break existing rows.
**Example (from existing 0003_governance_approval_columns.sql):**
```sql
-- Source: drizzle/0003_governance_approval_columns.sql
ALTER TABLE `runs` ADD `approval_context` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `approval_action` text;
```
New migration should follow same format with `--> statement-breakpoint` separators.

### Pattern 2: New Drizzle Table
**What:** Add a full `CREATE TABLE` + indexes in migration SQL and the corresponding `sqliteTable()` definition in schema.ts.
**When to use:** New persistent entity (delegations).
**Example (from existing 0002_condemned_matthew_murdock.sql):**
```sql
-- Source: drizzle/0002_condemned_matthew_murdock.sql
CREATE TABLE `execution_locks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lock_type` text NOT NULL,
	...
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_locks_lock_type_lock_key_unique` ON `execution_locks` (`lock_type`,`lock_key`);
```

### Pattern 3: Repository Factory
**What:** All repositories follow `createXRepository(db: AppDatabase): XRepository` with a private `deserializeRow()` helper and typed interfaces.
**When to use:** Any new table.
**Example (from src/storage/repositories/runs.ts):**
```typescript
// Source: src/storage/repositories/runs.ts

export interface RunRow { ... }
export interface RunInsertParams { ... }
export interface RunRepository { /* typed method signatures */ }

function deserializeRow(raw: typeof runs.$inferSelect): RunRow {
  return {
    // TEXT JSON columns: raw.field ? JSON.parse(raw.field) : null
    taskSpec: raw.task_spec ? JSON.parse(raw.task_spec) : null,
    // nullable TEXT → null
    childRunId: raw.child_run_id ?? null,
  };
}

export function createDelegationRepository(db: AppDatabase): DelegationRepository {
  return {
    insert(params) { ... db.insert(delegations).values(values).run(); return this.findById(...)!; },
    findById(id) { const row = db.select().from(delegations).where(eq(delegations.id, id)).get(); return row ? deserializeRow(row) : undefined; },
    ...
  };
}
```
Auto-increment PKs: read back via `result.lastInsertRowid` cast with `Number()`.

### Pattern 4: PipelineNode Type Extension (backward-compatible)
**What:** Add optional fields to both the TypeScript interface and the Zod schema. Existing YAML with none of these fields still parses correctly.
**When to use:** Additive pipeline type changes.
**Example (extending src/pipeline/parser.ts PipelineNodeSchema):**
```typescript
// Source: src/pipeline/parser.ts pattern
const PipelineNodeSchema = z.object({
  id: z.string().regex(...),
  task: z.string().min(1),
  // ... existing fields ...
  node_type: z.enum(["task", "condition", "loop"]).optional(),
  condition: z.string().optional(),
  else_node: z.string().optional(),
  if_failed: z.string().optional(),
  if_passed: z.string().optional(),
  loop: z.object({
    until: z.string(),
    max_iterations: z.number().int().positive().optional(),
    body: z.array(z.string()).optional(),
  }).optional(),
});
```

### Anti-Patterns to Avoid
- **Running `drizzle-kit generate` to create migration files:** The migration must be hand-written to match the locked schema design. Do not auto-generate — the generated SQL should be verified against the decisions, and hand-writing avoids surprises in column naming or ordering.
- **Making delegation columns NOT NULL without defaults:** All new `runs` columns are nullable or have defaults; adding NOT NULL without a DEFAULT would break existing rows.
- **Importing filtrex in schema.ts or parser.ts:** Phase 20 only installs and typechecks filtrex. Do not use `compileExpression` in this phase — that is Phase 21's work.
- **Modifying dag.ts:** The DAG validator uses `depends_on` only. New node_type/condition/loop fields are ignored by dag.ts — no changes needed there.
- **Breaking the _journal.json manually:** The Drizzle journal is updated by the migrator at runtime when migrations run, not by hand. The SQL file is all that's needed at the `drizzle/` level.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Safe expression evaluation | Custom regex/eval parser | filtrex ^3.1.0 | Handles operator precedence, sandboxing, error containment; filtrex never throws during execution |
| SQL migration tracking | Custom migration version table | Drizzle migrator's built-in `__drizzle_migrations` table | Already used; idempotent; handles ordering |
| JSON column serialization | Custom encode/decode per field | Standard `JSON.stringify` / `JSON.parse` in `deserializeRow()` | Matches all existing repos |

**Key insight:** filtrex is sandboxed — it cannot access globals or call arbitrary functions unless explicitly passed in. This is the correct property for condition/loop expressions that should only reference node results.

## Common Pitfalls

### Pitfall 1: Migration naming — auto-generated tag vs. descriptive
**What goes wrong:** Drizzle-generated migration names look like `0005_foggy_wolverine.sql` (random adjective + character). The project has mixed naming — some auto (0000-0002) and some descriptive (0003, 0004).
**Why it happens:** `drizzle-kit generate` produces random names. Hand-writing allows descriptive names.
**How to avoid:** Use a descriptive tag for 0005: `0005_delegation_schema.sql`. The tag is just a filename — the `idx` and `when` in `_journal.json` are what the migrator actually uses for ordering.
**Warning signs:** If `drizzle-kit generate` is run, it will diff the schema and produce a migration. Verify the output before committing — it may produce different SQL than hand-writing.

### Pitfall 2: _journal.json not updated
**What goes wrong:** Adding `0005_delegation_schema.sql` without a matching entry in `drizzle/meta/_journal.json` means `runMigrations()` will not execute migration 5.
**Why it happens:** The journal is how Drizzle tracks which migrations to run. The file must be updated alongside the SQL file.
**How to avoid:** Add the `idx: 5` entry to `_journal.json` with a fresh timestamp (milliseconds since epoch). The `when` value is informational only — use `Date.now()`.
**Warning signs:** Running storage-migrator.test.ts after adding the SQL file but the table is not created → journal entry is missing.

### Pitfall 3: schema.ts drift from migration SQL
**What goes wrong:** `schema.ts` (the Drizzle TypeScript schema) and the `.sql` migration file are maintained separately. If they diverge, `drizzle-kit generate` will produce unwanted additional migrations.
**Why it happens:** Manual edits to one file without updating the other.
**How to avoid:** Treat the SQL migration and the schema.ts change as a single atomic commit. Verify by running `drizzle-kit check` or inspecting that `drizzle-kit generate` produces an empty diff after both files are updated.
**Warning signs:** `drizzle-kit generate` outputs a non-empty migration after the phase is done.

### Pitfall 4: filtrex ESM import in a Node ESM project
**What goes wrong:** filtrex ships `dist/cjs/filtrex.js` as `main` and `dist/esm/filtrex.mjs` as `module`. The package has no `exports` field in package.json (confirmed). Node ESM resolution in TypeScript projects with `"type": "module"` can be tricky without an exports map.
**Why it happens:** filtrex 3.1.0 lacks a `"exports"` field — it uses the legacy `main`/`module` fields.
**How to avoid:** Import via the bare specifier `import { compileExpression } from "filtrex"` — TypeScript will resolve to `dist/esm/filtrex.d.ts` (the `types` field). At runtime (Node ESM), it resolves to `dist/cjs/filtrex.js` (the `main` field). This is intentional — the CJS main works fine in Node regardless of project ESM type.
**Warning signs:** `Cannot find module 'filtrex'` in typecheck → `npm install filtrex` not run. Runtime `ERR_REQUIRE_ESM` → unlikely since main points to CJS.

### Pitfall 5: RunRow / schema.ts out of sync for new runs columns
**What goes wrong:** Adding columns to `schema.ts` and the migration SQL but forgetting to add them to `RunRow`, `RunInsertParams`, or `deserializeRow()` in `runs.ts`. Existing tests may not cover the new columns.
**Why it happens:** Three files must change atomically for a new runs column: schema.ts, migration SQL, runs.ts.
**How to avoid:** Touch all three in the same plan. New columns are: `parentRunId`, `role`, `depth`, `maxChildren`, `childrenDispatched` — all nullable or with defaults.
**Warning signs:** TypeScript complains that `runs.$inferSelect` has a field not present in `RunRow`.

### Pitfall 6: `noUnusedLocals: true` with filtrex install-only
**What goes wrong:** If a `filtrex` import is added to any file but `compileExpression` is not called in this phase, TypeScript will error with "declared but never read."
**Why it happens:** tsconfig has `noUnusedLocals: true`.
**How to avoid:** Do not import filtrex into any source file in Phase 20. The package only needs to be in `package.json`. The import happens in Phase 21 when conditions are evaluated. Optionally, add a re-export file `src/pipeline/expression.ts` that exports `compileExpression` (Phase 21 will use it), which makes the import used.
**Warning signs:** `npm run typecheck` fails with "is declared but its value is never read."

## Code Examples

Verified patterns from existing codebase sources:

### Migration SQL — ADD columns to runs
```sql
-- Pattern from drizzle/0003_governance_approval_columns.sql
ALTER TABLE `runs` ADD `parent_run_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `role` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `depth` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `runs` ADD `max_children` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `children_dispatched` integer DEFAULT 0;
```

### Migration SQL — CREATE TABLE delegations
```sql
-- Pattern from drizzle/0002_condemned_matthew_murdock.sql (execution_locks table)
CREATE TABLE `delegations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_run_id` text NOT NULL,
	`child_run_id` text,
	`task_spec` text NOT NULL,
	`status` text NOT NULL DEFAULT 'pending',
	`result` text,
	`retry_count` integer NOT NULL DEFAULT 0,
	`last_error` text,
	`created_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `delegations_parent_run_id_idx` ON `delegations` (`parent_run_id`);
--> statement-breakpoint
CREATE INDEX `delegations_child_run_id_idx` ON `delegations` (`child_run_id`);
```

### schema.ts — delegations table definition
```typescript
// Source: src/storage/schema.ts pattern (matches execution_locks)
export const delegations = sqliteTable("delegations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  parentRunId: text("parent_run_id").notNull(),
  childRunId: text("child_run_id"),
  taskSpec: text("task_spec").notNull(),        // JSON — deserialized in repo
  status: text("status").notNull().default("pending"),
  result: text("result"),                        // JSON nullable
  retryCount: integer("retry_count").notNull().default(0),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});
```

### runs table — new columns in schema.ts
```typescript
// Additive to existing sqliteTable("runs", { ... }) in src/storage/schema.ts
parentRunId: text("parent_run_id"),
role: text("role"),                              // 'lead' | 'worker' | null
depth: integer("depth").default(0),
maxChildren: integer("max_children"),
childrenDispatched: integer("children_dispatched").default(0),
```

### Repository — countByParentAndStatus
```typescript
// Pattern from src/storage/repositories/runs.ts (updateStatus style)
import { and, count, eq } from "drizzle-orm";

countByParentAndStatus(parentRunId: string, status: string): number {
  const result = db
    .select({ value: count() })
    .from(delegations)
    .where(and(eq(delegations.parentRunId, parentRunId), eq(delegations.status, status)))
    .get();
  return result?.value ?? 0;
},
```

### Repository — auto-increment PK insert pattern
```typescript
// Pattern from src/storage/repositories/events.ts (integer autoincrement PK)
insert(params: DelegationInsertParams): DelegationRow {
  const result = db.insert(delegations).values({
    parentRunId: params.parentRunId,
    childRunId: params.childRunId ?? null,
    taskSpec: JSON.stringify(params.taskSpec),
    status: params.status ?? "pending",
    result: null,
    retryCount: 0,
    lastError: null,
    createdAt: params.createdAt,
    completedAt: null,
  }).run();
  return this.findById(Number(result.lastInsertRowid))!;
},
```

### PipelineNode interface extension
```typescript
// Source: src/pipeline/types.ts (additive to existing interface)
export interface PipelineNode {
  id: string;
  task: string;
  depends_on?: string[];
  workflow?: string;
  agent?: string;
  repo?: string;
  review?: boolean;
  model?: string;
  input?: string[];
  context?: string[];
  pipe?: { mode: "branch" | "files" | "context" };
  // NEW fields — Phase 20
  node_type?: "task" | "condition" | "loop";
  condition?: string;
  else_node?: string;
  if_failed?: string;
  if_passed?: string;
  loop?: {
    until: string;
    max_iterations?: number;
    body?: string[];
  };
}
```

### _journal.json entry for migration 5
```json
{
  "idx": 5,
  "version": "6",
  "when": 1773200000000,
  "tag": "0005_delegation_schema",
  "breakpoints": true
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Drizzle `push` (no migration files) | Drizzle `migrate()` with SQL files | v2.0 | Production-safe, version-controlled schema changes |
| Manual migration tracking | `__drizzle_migrations` table (Drizzle built-in) | v2.0 | Idempotent; no custom version table needed |
| Hand-rolled expression parsers | filtrex sandboxed evaluator | v2.1 (this phase) | Zero-dependency, safe, no eval exposure |

**Deprecated/outdated:**
- `drizzle-kit push`: Only for dev prototyping. All production schema changes go through SQL migration files + `migrate()`.

## Open Questions

1. **`drizzle-kit generate` vs. hand-written migration**
   - What we know: The project has used both styles (0000-0002 appear auto-generated, 0003-0004 appear hand-written based on naming).
   - What's unclear: Whether running `drizzle-kit generate` after editing schema.ts produces correct SQL or requires tweaking.
   - Recommendation: Hand-write migration 0005 to match locked schema decisions exactly. Validate with `drizzle-kit check` afterward.

2. **filtrex `exports` field absence**
   - What we know: filtrex 3.1.0 has no `exports` field; uses legacy `main`/`module`/`types`.
   - What's unclear: Whether TypeScript's module resolution will pick up `dist/esm/filtrex.d.ts` from the `types` field under all tsconfig settings.
   - Recommendation: After `npm install filtrex`, run `npm run typecheck` immediately to verify the import resolves. If not, add `"filtrex"` to tsconfig `paths` or use `moduleResolution: "bundler"` if already configured.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^2.0.0 |
| Config file | vitest.config.ts (or package.json vitest key) |
| Quick run command | `FORGECTL_SKIP_DOCKER=true npm test -- --reporter=verbose test/unit/storage-migrator.test.ts test/unit/storage-runs-repo.test.ts` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npm test` |

### Phase Requirements → Test Map

This phase has no formal requirement IDs. It must satisfy 5 success criteria, mapped to test coverage:

| Success Criteria | Behavior | Test Type | Automated Command | File Exists? |
|-----------------|----------|-----------|-------------------|-------------|
| SC-1: Migration runs cleanly | ALTER TABLE adds 5 runs columns; CREATE TABLE delegations | integration | `FORGECTL_SKIP_DOCKER=true npm test -- storage-migrator` | ✅ existing (needs new assertions) |
| SC-2: delegations table CRUD | Insert, findById, findByParentRunId, etc. work | unit | `FORGECTL_SKIP_DOCKER=true npm test -- storage-delegations-repo` | ❌ Wave 0 |
| SC-3: PipelineNode accepts new fields | Zod parses node_type/condition/loop without error | unit | `FORGECTL_SKIP_DOCKER=true npm test -- pipeline-dag` | ✅ existing (needs new YAML cases) |
| SC-4: filtrex importable + typecheck passes | `import { compileExpression } from "filtrex"` resolves | build check | `npm run typecheck && npm run lint` | ✅ no new file needed |
| SC-5: All 1,021 existing tests pass | No regressions | full suite | `FORGECTL_SKIP_DOCKER=true npm test` | ✅ existing suite |

### Sampling Rate
- **Per task commit:** `FORGECTL_SKIP_DOCKER=true npm test -- storage-migrator storage-runs-repo`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/storage-delegations-repo.test.ts` — covers SC-2 (all 7 repository methods)
- [ ] Add assertions to `test/unit/storage-migrator.test.ts` — verify `delegations` table exists after migration

*(Existing pipeline-dag.test.ts covers SC-3 once new YAML fields are tested in place)*

## Sources

### Primary (HIGH confidence)
- Direct file reads: `src/storage/schema.ts`, `src/storage/repositories/runs.ts`, `src/storage/repositories/pipelines.ts`, `src/storage/migrator.ts`, `src/storage/database.ts` — confirmed patterns
- Direct file reads: `src/pipeline/types.ts`, `src/pipeline/parser.ts`, `src/pipeline/dag.ts` — confirmed interface shapes
- Direct file reads: `drizzle/0000-0004/*.sql`, `drizzle/meta/_journal.json` — confirmed migration format
- `npm pack filtrex@3.1.0 --dry-run` — confirmed bundled `.d.ts` type declarations at `dist/esm/filtrex.d.ts`
- `npm info filtrex@3.1.0 --json` — confirmed `types: "dist/esm/filtrex.d.ts"`, zero dependencies, MIT

### Secondary (MEDIUM confidence)
- [filtrex GitHub (cshaa fork)](https://github.com/cshaa/filtrex) — confirmed `compileExpression` import API
- [filtrex npm page](https://www.npmjs.com/package/filtrex) — confirmed v3.1.0 is latest, 319K weekly downloads

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified via npm and direct package inspection
- Architecture: HIGH — patterns read directly from existing codebase files
- Pitfalls: HIGH — derived from direct tsconfig/schema/migration inspection
- filtrex ESM behavior: MEDIUM — `exports` field absence confirmed via npm info, but runtime Node behavior is inferred

**Research date:** 2026-03-12
**Valid until:** 2026-04-12 (filtrex 3.1.0 stable; Drizzle ORM changes slowly)
