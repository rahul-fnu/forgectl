---
phase: 03-workflow-contract
verified: 2026-03-08T07:10:00Z
status: passed
score: 16/16 must-haves verified
---

# Phase 03: WORKFLOW.md Contract Verification Report

**Phase Goal:** In-repo workflow definition with YAML front matter, prompt templates, and dynamic reload.
**Verified:** 2026-03-08T07:10:00Z
**Status:** passed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | WORKFLOW.md with YAML front matter and markdown body is parsed into config object + prompt template string | VERIFIED | `parseWorkflowFile` in workflow-file.ts uses regex + yaml.load, returns `{ frontMatter, body }`. 14 tests pass. |
| 2 | Missing WORKFLOW.md throws an error | VERIFIED | `loadWorkflowFile` calls `readFile` which throws on missing file. Test confirms rejection. |
| 3 | Empty prompt body falls back to default prompt template | VERIFIED | `loadWorkflowFile` checks `body.trim().length > 0`, uses `DEFAULT_PROMPT_TEMPLATE` otherwise. Tested. |
| 4 | Front matter is validated with zod and unknown keys are rejected | VERIFIED | `WorkflowFrontMatterSchema` uses `.strict()`. Test confirms ZodError on unknown keys. |
| 5 | Prompt template renders issue fields via issue.* and attempt variables | VERIFIED | `renderPromptTemplate` in template.ts traverses dot-notation paths. 8 tests cover various scenarios. |
| 6 | Unknown template variables cause a render error (strict mode) | VERIFIED | `renderPromptTemplate` throws `Error("Unknown template variable: ...")` for unresolved vars. 2 tests confirm. |
| 7 | Arrays in template variables render as JSON arrays | VERIFIED | `Array.isArray` check returns `JSON.stringify(value)`. Test confirms `["bug","forgectl"]` output. |
| 8 | Null values in template variables render as empty string | VERIFIED | `value == null` check returns `""`. Tested with null priority. |
| 9 | Attempt renders as empty string on first run (null) | VERIFIED | `buildTemplateVars` maps `attempt: null` to `attempt: ""`. Tested. |
| 10 | File watcher detects WORKFLOW.md changes and reloads config | VERIFIED | `WorkflowFileWatcher.start()` uses `fs/promises watch()` async iterator, calls `loadWorkflowFile` on change. 8 tests pass. |
| 11 | Debounce prevents multiple reloads from rapid edits | VERIFIED | `clearTimeout/setTimeout` pattern with configurable `debounceMs`. Test confirms 3 rapid changes produce 1 reload. |
| 12 | Invalid WORKFLOW.md on reload keeps last known good config and emits warning | VERIFIED | `reload()` catches errors, keeps `lastGoodConfig` unchanged, calls `onWarning`. 3 tests confirm with invalid YAML and schema errors. |
| 13 | Watcher can be stopped cleanly via stop() | VERIFIED | `stop()` sets `stopped=true`, clears timer, aborts `AbortController`. Test confirms no reload after stop. |
| 14 | Config merge respects priority: CLI flags > WORKFLOW.md > forgectl.yaml > defaults | VERIFIED | `mergeWorkflowConfig` applies sequential `deepMerge` in correct order. 8 tests confirm each layer overrides previous. |
| 15 | WORKFLOW.md front matter overrides forgectl.yaml values | VERIFIED | Test "WORKFLOW.md overrides forgectl.yaml" passes: model "claude-3" beats "gpt-4". |
| 16 | CLI flags override WORKFLOW.md values | VERIFIED | Test "CLI overrides WORKFLOW.md" passes: model "opus" beats "claude-3". |

**Score:** 16/16 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/workflow/workflow-file.ts` | WORKFLOW.md parser with front matter extraction, zod validation, and file loading | VERIFIED | 130 lines. Exports parseWorkflowFile, loadWorkflowFile, WorkflowFrontMatterSchema, DEFAULT_PROMPT_TEMPLATE. |
| `src/workflow/template.ts` | Strict prompt template renderer with issue-aware variable map builder | VERIFIED | 61 lines. Exports renderPromptTemplate, buildTemplateVars. |
| `src/workflow/types.ts` | WorkflowFileConfig and ValidatedWorkflowFile types | VERIFIED | Contains WorkflowFileConfig interface and ValidatedWorkflowFile interface. |
| `src/workflow/watcher.ts` | WorkflowFileWatcher class with start/stop, debounce, last-known-good pattern | VERIFIED | 106 lines. Exports WorkflowFileWatcher class. |
| `src/workflow/merge.ts` | Config merge function layering WORKFLOW.md into config chain | VERIFIED | 22 lines. Exports mergeWorkflowConfig. |
| `test/unit/workflow-file.test.ts` | Unit tests for WORKFLOW.md parsing and validation | VERIFIED | 14 tests passing. |
| `test/unit/workflow-template.test.ts` | Unit tests for strict template rendering | VERIFIED | 13 tests passing. |
| `test/unit/workflow-watcher.test.ts` | Unit tests for watcher reload, debounce, error handling | VERIFIED | 8 tests passing. |
| `test/unit/workflow-merge.test.ts` | Unit tests for config merge priority | VERIFIED | 8 tests passing. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| workflow-file.ts | js-yaml | yaml.load() | WIRED | Line 102: `yaml.load(yamlContent)` |
| workflow-file.ts | zod schema | WorkflowFrontMatterSchema.parse() | WIRED | Line 121: `WorkflowFrontMatterSchema.parse(frontMatter)` |
| template.ts | tracker/types.ts | TrackerIssue type | WIRED | Line 1: import, Line 48: used as parameter type |
| watcher.ts | workflow-file.ts | loadWorkflowFile() | WIRED | Line 2: import, Line 95: called in reload() |
| watcher.ts | node:fs/promises | watch() | WIRED | Line 1: import, Line 43: used in start() |
| merge.ts | config/loader.ts | deepMerge() | WIRED | Line 1: import, Lines 18-20: used 3 times in sequence |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-----------|-------------|--------|----------|
| R4.1 | 03-01 | File Format: YAML front matter + markdown body | SATISFIED | parseWorkflowFile handles --- delimiters, yaml.load, zod validation, loadWorkflowFile with defaults |
| R4.2 | 03-01 | Prompt Template: strict rendering, issue vars, attempt | SATISFIED | renderPromptTemplate with strict mode, buildTemplateVars maps TrackerIssue + attempt |
| R4.3 | 03-02 | Dynamic Reload: watch, debounce, last-known-good | SATISFIED | WorkflowFileWatcher with fs watch, debounce timer, error recovery, warning callback |
| R4.4 | 03-02 | Config Merge: CLI > WORKFLOW.md > forgectl.yaml > defaults | SATISFIED | mergeWorkflowConfig with sequential deepMerge, all priority levels tested |

No orphaned requirements found -- all R4.x requirements mapped to this phase are covered.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | - | - | All 5 source files clean: no TODOs, placeholders, empty implementations, or console.log |

### Human Verification Required

None required. All behaviors are fully testable programmatically and verified via 43 passing unit tests.

### Gaps Summary

No gaps found. All 16 observable truths verified, all 9 artifacts exist and are substantive, all 6 key links are wired, all 4 requirements satisfied, and no anti-patterns detected. The existing `expandTemplate` in `src/utils/template.ts` was not modified (confirmed via git log).

---

_Verified: 2026-03-08T07:10:00Z_
_Verifier: Claude (gsd-verifier)_
