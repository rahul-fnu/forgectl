# Phase 20: Schema Foundation - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

SQLite migration and PipelineNode type extensions that all v2.1 features depend on. No behavioral change visible to users — pure foundation. Adds delegation schema, extends pipeline types, installs filtrex expression evaluator.

</domain>

<decisions>
## Implementation Decisions

### Delegations table design
- One record per child task (not per delegation event or per manifest)
- Columns: id (INTEGER PK auto), parentRunId (TEXT FK → runs.id), childRunId (TEXT FK → runs.id), taskSpec (TEXT JSON), status (TEXT: pending/dispatched/completed/failed), result (TEXT JSON nullable), retryCount (INTEGER DEFAULT 0), lastError (TEXT nullable), createdAt (TEXT), completedAt (TEXT nullable)
- taskSpec JSON mirrors the delegation manifest format from DELEG-01: `{id, task, workflow?, agent?}` — clean round-trip from manifest → table → dispatcher
- Retry handling: same row updated in place — increment retryCount, update taskSpec with new instructions, assign new childRunId, reset status to 'dispatched'

### Delegation repository methods
- Full query helpers included (not minimal CRUD):
  - `insert(params)`
  - `findById(id)`
  - `findByParentRunId(parentRunId)` — Phase 23 waitForChildren
  - `findByChildRunId(childRunId)` — child completion callback
  - `updateStatus(id, status, result?)` — status transitions
  - `countByParentAndStatus(parentRunId, status)` — slot budget enforcement
  - `list()`

### PipelineNode condition fields
- `condition` is a plain string (filtrex expression), not an object
- `else_node` is a separate optional string field (node ID for false-branch routing)
- `if_failed` and `if_passed` shorthand fields included in types now — Phase 21 implements the resolver that expands them to condition expressions

### PipelineNode loop field
- `loop` is an object: `{ until: string, max_iterations?: number, body?: string[] }`
- `until` is a filtrex expression evaluated after each iteration
- `max_iterations` has a global safety cap enforced in code (YAML value cannot exceed it)
- `body` lists node IDs that form the loop body (the nodes that repeat)

### PipelineNode node_type enum
- Three values: `'task' | 'condition' | 'loop'`
- Default is `'task'` (backward compatible — omitted in existing YAML)
- No `'delegation'` type — delegation is handled at the run level (manifest parsing in orchestrator), not at the pipeline node level

### Claude's Discretion
- Migration file naming/tag (next sequential: 0005_*)
- Exact Zod schema validation rules for new fields
- Whether to add indexes on delegations table (parentRunId, childRunId)
- filtrex import/re-export pattern
- Runs table column ordering in migration SQL

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/storage/schema.ts`: Drizzle table definitions — runs table needs 5 new columns added here
- `src/storage/repositories/`: 4 existing repositories follow consistent factory pattern (`createXRepository(db)`)
- `src/storage/migrator.ts`: Drizzle migrate() with multi-path resolution (dev/prod/fallback)
- `src/pipeline/types.ts`: PipelineNode interface (lines 19-33) — add new fields here
- `src/pipeline/parser.ts`: PipelineNodeSchema Zod validation (lines 6-20) — extend with new field schemas

### Established Patterns
- Repository pattern: Row interface → Params interfaces → deserializeRow() → factory function
- JSON columns: stored as TEXT, deserialized in repository layer via JSON.parse()
- Migration naming: `NNNN_<descriptive-tag>.sql` (5 migrations exist: 0000-0004)
- Schema column naming: snake_case in SQL, camelCase in TypeScript interfaces
- Auto-increment PKs: accessed via `result.lastInsertRowid` cast to `Number`

### Integration Points
- `drizzle/` directory: next migration file (0005)
- `drizzle/meta/_journal.json`: migration metadata tracking
- `drizzle.config.ts`: Drizzle configuration
- `src/pipeline/dag.ts`: DAG validation (validateDAG, topologicalSort) — must not break with new node types
- `package.json`: filtrex ^3.1.0 needs to be added as dependency

</code_context>

<specifics>
## Specific Ideas

No specific requirements — standard patterns. Key insight: all type shapes are designed to be consumed by downstream phases without reshaping (delegation manifest → taskSpec JSON round-trip, condition string → filtrex evaluation, loop object → executor iteration).

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 20-schema-foundation*
*Context gathered: 2026-03-12*
