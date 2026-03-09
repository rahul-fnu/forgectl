# Phase 3: WORKFLOW.md Contract — Context Decisions

## A: Front Matter Scope & Schema

- **A1:** Orchestrator-specific settings only (tracker overrides, polling, concurrency, hooks, agent type). Not a duplicate of forgectl.yaml.
- **A2:** WORKFLOW.md references a base workflow via `extends` and overrides specific fields. Reuses existing profile system.
- **A3:** Use `extends` key to match existing custom workflow convention.
- **A4:** One WORKFLOW.md per repo. All issues use the same policy.

## B: Template Variable Handling

- **B1:** Arrays render as JSON arrays: `["bug", "forgectl"]`
- **B2:** Null values render as empty string `""`
- **B3:** `{{attempt}}` renders as empty string on first run
- **B4:** Minimal default prompt when body is empty:
  ```
  Resolve the following issue: {{issue.title}}

  {{issue.description}}
  ```

## C: File Discovery & Naming

- **C1:** Configurable path (default `WORKFLOW.md` at repo root)
- **C2:** Missing file is an error for both `forgectl run` and daemon when workflow file is referenced
- **C3:** Front matter required (even if empty `---\n---`)
- **C4:** Repo path derived from tracker config (GitHub adapter has `repo`, Notion gets a `repo_path` field)

## D: Reload Behavior & Watcher

- **D1:** Implementation at Claude's discretion — pick the most pragmatic approach
- **D2:** Configurable debounce with sensible default
- **D3:** Already-queued-but-not-dispatched issues pick up new config; in-flight sessions untouched
- **D4:** Invalid reload warnings surface in both daemon log AND SSE events
