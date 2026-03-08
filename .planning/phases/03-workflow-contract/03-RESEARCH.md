# Phase 3: WORKFLOW.md Contract - Research

**Researched:** 2026-03-08
**Domain:** YAML front matter parsing, template rendering, file watching, config merge
**Confidence:** HIGH

## Summary

Phase 3 adds a WORKFLOW.md file format that combines YAML front matter (orchestrator config overrides) with a markdown body (prompt template). The project already has all core dependencies needed: `js-yaml` for YAML parsing, `zod` for validation, and `src/utils/template.ts` for `{{variable}}` expansion. The existing `deepMerge` utility in `src/config/loader.ts` handles config layering.

The three main technical challenges are: (1) parsing front matter from markdown, (2) adapting the existing template engine to support strict mode and issue-specific variables, and (3) implementing a file watcher with debounce and graceful error handling. All are straightforward with existing Node.js APIs and project conventions.

**Primary recommendation:** Hand-roll front matter parsing with `js-yaml` (already a dependency) rather than adding `gray-matter`. The parsing logic is ~15 lines for a single-file format with known delimiters. Use `node:fs/promises` `watch()` for file watching -- it returns an `AsyncIterableIterator` that is clean and sufficient for watching a single known file.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **A1:** Front matter scope is orchestrator-specific settings only (tracker overrides, polling, concurrency, hooks, agent type). Not a duplicate of forgectl.yaml.
- **A2:** WORKFLOW.md references a base workflow via `extends` and overrides specific fields. Reuses existing profile system.
- **A3:** Use `extends` key to match existing custom workflow convention.
- **A4:** One WORKFLOW.md per repo. All issues use the same policy.
- **B1:** Arrays render as JSON arrays: `["bug", "forgectl"]`
- **B2:** Null values render as empty string `""`
- **B3:** `{{attempt}}` renders as empty string on first run
- **B4:** Minimal default prompt when body is empty (template provided in CONTEXT.md)
- **C1:** Configurable path (default `WORKFLOW.md` at repo root)
- **C2:** Missing file is an error for both `forgectl run` and daemon when workflow file is referenced
- **C3:** Front matter required (even if empty `---\n---`)
- **C4:** Repo path derived from tracker config (GitHub adapter has `repo`, Notion gets a `repo_path` field)
- **D1:** Watcher implementation at Claude's discretion
- **D2:** Configurable debounce with sensible default
- **D3:** Already-queued-but-not-dispatched issues pick up new config; in-flight sessions untouched
- **D4:** Invalid reload warnings surface in both daemon log AND SSE events

### Claude's Discretion
- **D1:** Watcher implementation approach (recommendation below in Architecture Patterns)

### Deferred Ideas (OUT OF SCOPE)
(none listed)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| R4.1 | File Format: YAML front matter + markdown body, front matter parsed as config, body as prompt template, missing = error, empty body = default prompt | Hand-roll parser with js-yaml; zod schema for front matter validation; default prompt constant |
| R4.2 | Prompt Template: `{{issue.*}}`, `{{attempt}}` variables, strict rendering (fail on unknown), attempt null on first run | Modify existing `expandTemplate` to add strict mode; build `TrackerIssue`-based variable map with JSON array serialization |
| R4.3 | Dynamic Reload: Watch file, re-read/re-parse/re-validate, invalid = keep last good + warn, apply to queued but not in-flight | `node:fs/promises` watch API with debounce; last-known-good pattern; Logger + SSE for warnings |
| R4.4 | Config Merge: WORKFLOW.md merges with forgectl.yaml and CLI flags, priority: CLI > WORKFLOW.md > forgectl.yaml > defaults | Existing `deepMerge` utility; new merge function that layers WORKFLOW.md front matter into config chain |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| js-yaml | ^4.1.0 | Parse YAML front matter | Already a project dependency, used in config/loader.ts and workflow/custom.ts |
| zod | ^3.23.0 | Validate front matter schema | Already a project dependency, used for all config validation |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:fs/promises | built-in | File reading and `watch()` API | For watching WORKFLOW.md changes |
| node:path | built-in | File path resolution | For WORKFLOW.md discovery |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-roll front matter | gray-matter npm package | gray-matter adds a dependency for ~15 lines of code; it wraps js-yaml internally anyway |
| node:fs/promises watch | chokidar | Chokidar is overkill for watching a single known file; adds native dependency complexity |

**Installation:**
```bash
# No new dependencies needed -- all requirements met by existing stack
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── workflow/
│   ├── workflow-file.ts    # WORKFLOW.md parser (front matter + body extraction)
│   ├── watcher.ts          # File watcher with debounce + reload + validation
│   ├── template.ts         # Issue-aware prompt template renderer (wraps utils/template.ts)
│   ├── types.ts            # (existing) Extended with WorkflowFileConfig type
│   ├── registry.ts         # (existing) No changes needed
│   ├── resolver.ts         # (existing) Modified to accept WORKFLOW.md config in merge chain
│   ├── custom.ts           # (existing) No changes needed
│   └── builtins/           # (existing) No changes needed
```

### Pattern 1: Front Matter Parser
**What:** Parse `---` delimited YAML from top of markdown file, return `{ frontMatter: object, body: string }`
**When to use:** Loading WORKFLOW.md
**Example:**
```typescript
// Source: project convention (js-yaml + manual delimiter splitting)
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";

interface ParsedWorkflowFile {
  frontMatter: Record<string, unknown>;
  body: string;
}

export function parseWorkflowFile(content: string): ParsedWorkflowFile {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("WORKFLOW.md must have YAML front matter delimited by ---");
  }
  const rawYaml = match[1];
  const body = match[2].trim();
  const frontMatter = (yaml.load(rawYaml) ?? {}) as Record<string, unknown>;
  return { frontMatter, body };
}
```

### Pattern 2: Strict Template Rendering
**What:** Expand `{{var}}` placeholders but throw on unknown variables instead of leaving them as-is
**When to use:** Rendering prompt templates with issue data
**Example:**
```typescript
// Extends existing src/utils/template.ts pattern
// Key differences from existing expandTemplate:
// 1. Strict mode: throws on unresolved variables
// 2. Arrays serialize as JSON: ["bug", "forgectl"]
// 3. Null/undefined serialize as empty string ""

export function renderPromptTemplate(
  template: string,
  vars: Record<string, unknown>
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, key: string) => {
    const parts = key.split(".");
    let value: unknown = vars;
    for (const part of parts) {
      if (value == null || typeof value !== "object") {
        throw new Error(`Unknown template variable: {{${key}}}`);
      }
      value = (value as Record<string, unknown>)[part];
    }
    if (value == null) return "";
    if (Array.isArray(value)) return JSON.stringify(value);
    return String(value);
  });
}
```

### Pattern 3: File Watcher with Debounce
**What:** Watch a single file for changes, debounce rapid edits, reload with validation
**When to use:** Daemon runtime for hot-reloading WORKFLOW.md
**Example:**
```typescript
// Source: Node.js fs/promises watch API (Node 20+)
import { watch } from "node:fs/promises";

export class WorkflowFileWatcher {
  private abortController: AbortController | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastGoodConfig: ParsedWorkflowFile | null = null;

  async start(filePath: string, debounceMs: number, onReload: (config: ParsedWorkflowFile) => void): Promise<void> {
    this.abortController = new AbortController();
    const watcher = watch(filePath, { signal: this.abortController.signal });
    for await (const event of watcher) {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.reload(filePath, onReload), debounceMs);
    }
  }

  stop(): void {
    this.abortController?.abort();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }
}
```

### Pattern 4: Config Merge Chain
**What:** Layer WORKFLOW.md front matter into the existing config merge chain
**When to use:** Building the final orchestrator config for dispatch
**Example:**
```typescript
// Merge priority: CLI flags > WORKFLOW.md > forgectl.yaml > defaults
// Uses existing deepMerge from src/config/loader.ts

import { deepMerge } from "../config/loader.js";

function buildOrchestratorConfig(
  defaults: ForgectlConfig,
  forgectlYaml: Partial<ForgectlConfig>,
  workflowFrontMatter: Partial<ForgectlConfig>,
  cliFlags: Partial<ForgectlConfig>
): ForgectlConfig {
  let config = deepMerge(defaults, forgectlYaml);
  config = deepMerge(config, workflowFrontMatter);
  config = deepMerge(config, cliFlags);
  return config;
}
```

### Anti-Patterns to Avoid
- **Duplicating WorkflowSchema in front matter:** Front matter is NOT a full workflow definition. It contains only orchestrator overrides (tracker, polling, concurrency, hooks, agent type). The `extends` key references a base workflow profile.
- **Mutating shared config:** The watcher must produce a new config object on each reload, not mutate the existing one. In-flight sessions hold references to old config.
- **Blocking the event loop during parse:** `yaml.load()` is synchronous but fast for small files. No need for worker threads.
- **Using `fs.watchFile` (polling):** Use `fs.watch` or the `fs/promises` `watch()` async iterator. `watchFile` polls and wastes CPU.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| YAML parsing | Custom YAML parser | `js-yaml` (already installed) | YAML spec is complex, edge cases abound |
| Schema validation | Manual type checking | `zod` (already installed) | Zod gives typed output + readable errors |
| Deep object merge | Recursive merge function | `deepMerge` from `src/config/loader.ts` | Already handles arrays-replace-not-merge semantics |
| Duration parsing | Regex + manual conversion | `parseDuration` from `src/utils/duration.ts` | Already handles `30s`, `5m`, `1h` formats |

**Key insight:** This phase's unique logic is minimal -- front matter splitting (~15 lines), strict template rendering (~20 lines), and watcher orchestration (~40 lines). Everything else reuses existing infrastructure.

## Common Pitfalls

### Pitfall 1: Front Matter Regex Edge Cases
**What goes wrong:** The `---` delimiter regex fails on files with `---` inside code blocks or content
**Why it happens:** Naive regex matches any `---` line
**How to avoid:** Only match `---` at the very start of the file (position 0), and use a non-greedy match for the closing `---`. The standard convention is: first `---` must be line 1, second `---` ends front matter.
**Warning signs:** Tests with markdown content containing horizontal rules (`---`) fail

### Pitfall 2: Template Variable Scope Confusion
**What goes wrong:** `{{title}}` works but `{{issue.title}}` does not (or vice versa)
**Why it happens:** Inconsistent variable nesting -- the variable map must nest issue fields under `issue.*`
**How to avoid:** Define a clear variable map structure: `{ issue: TrackerIssue, attempt: number | "" }`. All issue fields accessed via `issue.` prefix.
**Warning signs:** Template renders differently than users expect from CONTEXT.md decisions

### Pitfall 3: Watcher Fires Multiple Events
**What goes wrong:** Single file save triggers 2-3 reload attempts
**Why it happens:** Editors save files in multiple steps (write temp, rename, update metadata)
**How to avoid:** Debounce with configurable delay (default 300ms). Only process the last event in a burst.
**Warning signs:** "Config reloaded" log message appears multiple times per save

### Pitfall 4: Race Between Reload and Dispatch
**What goes wrong:** Dispatch reads config while reload is mid-parse
**Why it happens:** Async reload and sync config access without coordination
**How to avoid:** Atomic swap pattern -- parse new config fully, validate, then replace the reference in one assignment. JavaScript single-threaded execution guarantees the swap is atomic if done synchronously after async parse.
**Warning signs:** Partial config objects, missing fields during dispatch

### Pitfall 5: Existing expandTemplate Leaves Unresolved Vars
**What goes wrong:** Using the existing `expandTemplate` function for prompt rendering silently leaves `{{unknown}}` in output
**Why it happens:** By design, `expandTemplate` returns unmatched placeholders as-is (see `src/utils/template.ts` line 11)
**How to avoid:** Create a NEW function (e.g., `renderPromptTemplate`) with strict mode. Do NOT modify `expandTemplate` -- it's used elsewhere with the leave-as-is behavior.
**Warning signs:** Prompts containing literal `{{variable}}` text reaching the agent

## Code Examples

### Building the Template Variable Map from TrackerIssue
```typescript
// Source: project types (src/tracker/types.ts TrackerIssue interface)
import type { TrackerIssue } from "../tracker/types.js";

export function buildTemplateVars(
  issue: TrackerIssue,
  attempt: number | null
): Record<string, unknown> {
  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      state: issue.state,
      priority: issue.priority ?? "",
      labels: issue.labels,       // B1: renders as JSON array
      assignees: issue.assignees, // B1: renders as JSON array
      url: issue.url,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
    },
    attempt: attempt ?? "",        // B3: empty string on first run
  };
}
```

### Front Matter Zod Schema (Orchestrator Overrides Only)
```typescript
// Source: CONTEXT.md A1 + existing TrackerConfigSchema/WorkspaceConfigSchema
import { z } from "zod";
import { TrackerConfigSchema, WorkspaceConfigSchema, AgentType } from "../config/schema.js";

export const WorkflowFrontMatterSchema = z.object({
  extends: z.string().optional(),            // A2/A3: base workflow profile
  tracker: TrackerConfigSchema.partial().optional(),
  polling: z.object({
    interval_ms: z.number().int().positive().optional(),
  }).optional(),
  concurrency: z.object({
    max_agents: z.number().int().positive().optional(),
  }).optional(),
  workspace: WorkspaceConfigSchema.partial().optional(),
  agent: z.object({
    type: AgentType.optional(),
    model: z.string().optional(),
    timeout: z.string().optional(),
  }).optional(),
}).strict();  // strict() rejects unknown keys -- catches typos
```

### Default Prompt Constant
```typescript
// Source: CONTEXT.md B4
export const DEFAULT_PROMPT_TEMPLATE = `Resolve the following issue: {{issue.title}}

{{issue.description}}`;
```

### Loading and Validating WORKFLOW.md
```typescript
export async function loadWorkflowFile(filePath: string): Promise<ValidatedWorkflowFile> {
  const content = await readFile(filePath, "utf-8");
  const { frontMatter, body } = parseWorkflowFile(content);
  const validated = WorkflowFrontMatterSchema.parse(frontMatter);
  const promptTemplate = body || DEFAULT_PROMPT_TEMPLATE;
  return { config: validated, promptTemplate };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `fs.watchFile` (polling) | `fs/promises` `watch()` async iterator | Node 15.9+ (stable in 20) | Non-polling, uses OS-level file notifications |
| Callback-based `fs.watch` | `fs/promises` `watch()` with `AbortController` | Node 18+ | Clean cancellation via abort signal |
| `gray-matter` for front matter | Hand-roll with js-yaml for simple cases | N/A | Fewer dependencies when format is well-defined |

**Deprecated/outdated:**
- `fs.watchFile`: Polling-based, wastes CPU. Use `fs.watch` or `fs/promises` `watch()` instead.

## Open Questions

1. **Front matter schema strictness**
   - What we know: CONTEXT.md says front matter contains orchestrator settings only (A1)
   - What's unclear: Should unknown keys in front matter cause a parse error or just be ignored?
   - Recommendation: Use zod `.strict()` to reject unknown keys -- catches typos early. This aligns with C3 (front matter required) implying structure matters.

2. **Watcher restart on file deletion/recreation**
   - What we know: WORKFLOW.md missing is an error (C2)
   - What's unclear: If the file is deleted while the watcher is running, should the watcher crash or wait for recreation?
   - Recommendation: On deletion, log an error and keep last-known-good config. The watcher should handle `ENOENT` gracefully and continue watching the parent directory for file recreation.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (latest, via devDependencies) |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run test/unit/workflow-file.test.ts` |
| Full suite command | `FORGECTL_SKIP_DOCKER=true npx vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| R4.1-a | Parse front matter + body from WORKFLOW.md | unit | `npx vitest run test/unit/workflow-file.test.ts -t "parse"` | No - Wave 0 |
| R4.1-b | Missing file throws error | unit | `npx vitest run test/unit/workflow-file.test.ts -t "missing"` | No - Wave 0 |
| R4.1-c | Empty body uses default prompt | unit | `npx vitest run test/unit/workflow-file.test.ts -t "default"` | No - Wave 0 |
| R4.1-d | Front matter validated with zod | unit | `npx vitest run test/unit/workflow-file.test.ts -t "validate"` | No - Wave 0 |
| R4.2-a | Render template with issue variables | unit | `npx vitest run test/unit/workflow-template.test.ts -t "render"` | No - Wave 0 |
| R4.2-b | Unknown variable throws error (strict) | unit | `npx vitest run test/unit/workflow-template.test.ts -t "unknown"` | No - Wave 0 |
| R4.2-c | Arrays render as JSON arrays | unit | `npx vitest run test/unit/workflow-template.test.ts -t "array"` | No - Wave 0 |
| R4.2-d | Null renders as empty string | unit | `npx vitest run test/unit/workflow-template.test.ts -t "null"` | No - Wave 0 |
| R4.2-e | Attempt renders as empty on first run | unit | `npx vitest run test/unit/workflow-template.test.ts -t "attempt"` | No - Wave 0 |
| R4.3-a | Watcher detects file change and reloads | unit | `npx vitest run test/unit/workflow-watcher.test.ts -t "reload"` | No - Wave 0 |
| R4.3-b | Invalid reload keeps last good config | unit | `npx vitest run test/unit/workflow-watcher.test.ts -t "invalid"` | No - Wave 0 |
| R4.3-c | Warning emitted on invalid reload | unit | `npx vitest run test/unit/workflow-watcher.test.ts -t "warning"` | No - Wave 0 |
| R4.3-d | Debounce prevents rapid reloads | unit | `npx vitest run test/unit/workflow-watcher.test.ts -t "debounce"` | No - Wave 0 |
| R4.4-a | Config merge: WORKFLOW.md overrides forgectl.yaml | unit | `npx vitest run test/unit/workflow-merge.test.ts -t "override"` | No - Wave 0 |
| R4.4-b | Config merge: CLI flags override WORKFLOW.md | unit | `npx vitest run test/unit/workflow-merge.test.ts -t "cli"` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run test/unit/workflow-file.test.ts test/unit/workflow-template.test.ts test/unit/workflow-watcher.test.ts test/unit/workflow-merge.test.ts`
- **Per wave merge:** `FORGECTL_SKIP_DOCKER=true npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/unit/workflow-file.test.ts` -- covers R4.1 (parsing, validation, defaults)
- [ ] `test/unit/workflow-template.test.ts` -- covers R4.2 (template rendering, strict mode)
- [ ] `test/unit/workflow-watcher.test.ts` -- covers R4.3 (reload, debounce, error handling)
- [ ] `test/unit/workflow-merge.test.ts` -- covers R4.4 (config merge priority)

## Sources

### Primary (HIGH confidence)
- Project source code: `src/utils/template.ts`, `src/config/loader.ts`, `src/config/schema.ts`, `src/workflow/` -- existing patterns
- Project source code: `src/tracker/types.ts` -- TrackerIssue model for template variables
- Node.js docs: `fs/promises` `watch()` API -- built-in file watching

### Secondary (MEDIUM confidence)
- [gray-matter GitHub](https://github.com/jonschlinkert/gray-matter) -- confirmed it wraps js-yaml; validated decision to hand-roll
- [Vite issue #12495](https://github.com/vitejs/vite/issues/12495) -- discussion of fs.watch reliability in Node 19+
- [chokidar GitHub](https://github.com/paulmillr/chokidar) -- evaluated and rejected for single-file use case

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already in use, no new dependencies
- Architecture: HIGH -- patterns follow existing project conventions exactly
- Pitfalls: HIGH -- based on direct code analysis of existing template.ts behavior and known fs.watch quirks

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (stable domain, no fast-moving dependencies)
