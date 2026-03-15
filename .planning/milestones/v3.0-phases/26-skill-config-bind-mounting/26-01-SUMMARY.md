---
phase: 26-skill-config-bind-mounting
plan: "01"
subsystem: skills
tags: [skill-mounting, docker-binds, credential-security, config-schema, zod]
dependency_graph:
  requires: []
  provides: [src/skills/mount.ts, WorkflowDefinition.skills, WorkflowFrontMatterSchema.skills, WorkflowFileConfig.skills]
  affects: [src/config/schema.ts, src/workflow/workflow-file.ts, src/workflow/types.ts, src/orchestrator/worker.ts]
tech_stack:
  added: []
  patterns: [readdirSync recursive scan, ContainerMounts return type, Zod optional vs default]
key_files:
  created:
    - src/skills/mount.ts
    - test/unit/skill-mount.test.ts
  modified:
    - src/config/schema.ts
    - src/workflow/types.ts
    - src/workflow/workflow-file.ts
    - src/workflow/builtins/browser-research.ts
    - src/workflow/builtins/code.ts
    - src/workflow/builtins/content.ts
    - src/workflow/builtins/data.ts
    - src/workflow/builtins/general.ts
    - src/workflow/builtins/ops.ts
    - src/workflow/builtins/research.ts
    - src/orchestrator/worker.ts
    - test/unit/workflow-file.test.ts
    - test/unit/config.test.ts
decisions:
  - "WorkflowFrontMatterSchema uses .optional() not .default([]) for skills -- absent means not specified, not empty array (override semantics)"
  - "CREDENTIAL_DENY_LIST uses basename matching after split('/') -- handles recursive readdirSync paths like subdir/.credentials.json"
  - "No project logger import in mount.ts -- avoids heavy dependency chain in utility module"
metrics:
  duration_seconds: 234
  completed_date: "2026-03-13"
  tasks_completed: 2
  files_created: 2
  files_modified: 13
---

# Phase 26 Plan 01: Skill Mount Module and Schema Extensions Summary

Skill mount module with credential security validation, Docker bind-mount preparation, and schema extensions for skills support across WorkflowSchema, WorkflowFrontMatterSchema, and WorkflowFileConfig.

## What Was Built

### src/skills/mount.ts
New module providing the foundational skill-mounting infrastructure:
- `CREDENTIAL_DENY_LIST` — Set of 7 credential file/dir patterns that must never appear in skill dirs
- `validateNoCredentials(hostPath)` — Recursive scan using `readdirSync({ recursive: true })`, throws on any basename matching the deny list with a descriptive security violation message
- `prepareSkillMounts(skills, noSkills)` — Prepares Docker bind mounts for Claude Code skills; checks `~/.claude/skills/<name>` and `~/.claude/agents/<name>` for each requested skill; mounts `~/CLAUDE.md` when present; emits `--add-dir` and its value as separate array entries for shellEscape compatibility; returns `{ mounts: ContainerMounts, addDirFlags: string[] }`

### Schema Extensions
- `WorkflowSchema` (src/config/schema.ts): `skills: z.array(z.string()).default([])`
- `WorkflowFrontMatterSchema` (src/workflow/workflow-file.ts): `skills: z.array(z.string()).optional()`
- `WorkflowFileConfig` interface (src/workflow/types.ts): `skills?: string[]`

### test/unit/skill-mount.test.ts
19 unit tests covering all behaviors: CREDENTIAL_DENY_LIST contents, validateNoCredentials (clean dir, each deny-listed pattern, recursive detection, descriptive error message, substring false-positive avoidance), prepareSkillMounts (noSkills flag, empty array, skills/ dir, agents/ dir, both dirs, missing dirs, CLAUDE.md, multiple skills, credential violation, separate --add-dir entries, env/cleanup shape).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Missing skills field on all built-in WorkflowDefinition objects**
- **Found during:** Task 2 typecheck
- **Issue:** Adding `skills` to `WorkflowSchema` made it required in the TypeScript type `WorkflowDefinition`. All 7 built-in workflow files and the worker's inline workflow object were missing this field, causing 8 type errors.
- **Fix:** Added `skills: []` to each of the 7 builtin files and the worker's inline `workflow` object literal.
- **Files modified:** src/workflow/builtins/{browser-research,code,content,data,general,ops,research}.ts, src/orchestrator/worker.ts
- **Commit:** 239afb1

## Commits

| Hash | Message |
|------|---------|
| 2844cfc | test(26-01): add failing tests for skill mount module |
| 27fb3b5 | feat(26-01): implement skill mount module with credential validation |
| 239afb1 | feat(26-01): extend schemas and config with skills field |

## Test Results

- test/unit/skill-mount.test.ts: 19/19 passed
- test/unit/workflow-file.test.ts: 19/19 passed (16 existing + 3 new)
- test/unit/config.test.ts: 16/16 passed (14 existing + 2 new)
- npm run typecheck: no errors

## Self-Check: PASSED
