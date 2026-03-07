# Phase 1: Tracker Adapter Interface + GitHub Issues + Notion - Context

**Gathered:** 2026-03-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Pluggable issue tracker abstraction with working GitHub Issues and Notion implementations. Defines the TrackerAdapter interface, normalized TrackerIssue model, and two concrete adapters (GitHub Issues, Notion database). Includes polling, pagination, normalization, rate limit handling, and write-back. The orchestration state machine and dispatch logic are Phase 5.

</domain>

<decisions>
## Implementation Decisions

### TrackerIssue model shape
- Include `metadata: Record<string, unknown>` catch-all for tracker-specific fields (GitHub: reactions, PR refs; Notion: rich text blocks)
- `blocked_by: string[]` — array of issue identifiers that block this one. GitHub: parsed from issue body links. Notion: relation property
- Full body in `description` field — no truncation. Needed for prompt rendering (`{{issue.description}}`)
- Notion rich text converted to markdown for the `description` field — preserves structure (headings, lists, code blocks)

### Write-back behavior
- Structured summary comments — markdown with sections: Status, Branch/PR link, Validation results, Token usage
- Configurable label management — adapter adds/removes labels based on state transitions. Label names configurable in tracker config (e.g., `in_progress_label`, `done_label`)
- Auto-close is configurable, default off — `tracker.auto_close: false` by default. User reviews and closes manually unless opted in
- Notion write-back updates properties (Status, labels) AND posts comments — full integration with the database

### Config & auth ergonomics
- Token resolution via `$ENV_VAR` reference — config specifies `token: $GITHUB_TOKEN` or `token: $NOTION_TOKEN`, resolved from environment at runtime. Simple, CI-friendly
- Explicit `property_map` for Notion — user specifies exact mapping: `property_map: { title: "Task Name", status: "Stage", priority: "Urgency" }`. No auto-detection
- Eager config validation at startup — validate token, repo/database_id, property_map at adapter creation. Fail immediately with clear error message

### Polling & rate limits
- 60s default poll interval, configurable via `polling.interval_ms`
- GitHub: pause polling until reset when `X-RateLimit-Remaining` drops below threshold. Log warning
- Notion: built-in throttle queue enforcing max 3 requests/second. All Notion API calls go through the queue
- Native fetch (Node 20+) for all HTTP calls — no Octokit or other HTTP library dependencies

### Claude's Discretion
- Config location (forgectl.yaml only vs also WORKFLOW.md front matter)
- ETag caching implementation details
- Delta polling cursor storage mechanism
- Pagination helper design
- Throttle queue implementation approach

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/agent/types.ts` + `src/agent/registry.ts`: Adapter + registry pattern to mirror for TrackerAdapter
- `src/config/schema.ts`: Zod schema patterns for config validation — extend with tracker config section
- `src/auth/`: BYOK credential pattern (keytar-based) — tracker uses $ENV_VAR instead but same validation philosophy

### Established Patterns
- Adapter interface + registry lookup by string key (see `getAgentAdapter()`)
- Zod schemas with `.default()` for config sections
- TypeScript ESM with `.js` import extensions
- Async/await everywhere, no callbacks

### Integration Points
- `src/config/schema.ts` — add `tracker` section to `ConfigSchema`
- `src/agent/registry.ts` — mirror pattern for `src/tracker/registry.ts`
- Future integration: Phase 5 orchestrator will call `fetchCandidateIssues()` and write-back methods

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-tracker-adapter-github-notion*
*Context gathered: 2026-03-07*
