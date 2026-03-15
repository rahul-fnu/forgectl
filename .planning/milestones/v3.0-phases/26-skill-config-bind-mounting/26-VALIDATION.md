---
phase: 26
slug: skill-config-bind-mounting
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-13
---

# Phase 26 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) |
| **Config file** | `vitest.config.ts` (existing) |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npm test -- --reporter=verbose test/unit/skill-mount.test.ts` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npm test -- --reporter=verbose test/unit/skill-mount.test.ts`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 26-01-01 | 01 | 1 | SKILL-05 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/config.test.ts` | ✅ (extend) | ⬜ pending |
| 26-01-02 | 01 | 1 | SKILL-04 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/workflow-file.test.ts` | ✅ (extend) | ⬜ pending |
| 26-02-01 | 02 | 1 | SKILL-01 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/skill-mount.test.ts` | ❌ W0 | ⬜ pending |
| 26-02-02 | 02 | 1 | SKILL-02 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/skill-mount.test.ts` | ❌ W0 | ⬜ pending |
| 26-03-01 | 03 | 2 | SKILL-02 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/skill-mount.test.ts` | ❌ W0 | ⬜ pending |
| 26-03-02 | 03 | 2 | SKILL-03 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/agent.test.ts` | ✅ (extend) | ⬜ pending |
| 26-04-01 | 04 | 2 | SKILL-01, SKILL-02, SKILL-03 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/skill-mount.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/skill-mount.test.ts` — stubs for SKILL-01, SKILL-02 (new file)
- [ ] Extend `test/unit/workflow-file.test.ts` — add `skills` field cases for SKILL-04, SKILL-05
- [ ] Extend `test/unit/config.test.ts` — add `WorkflowSchema` skills field case for SKILL-05
- [ ] Extend `test/unit/agent.test.ts` — verify `--add-dir` flags in `buildShellCommand()` output for SKILL-03

*Existing infrastructure covers framework and config — only new test files and extensions needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Claude Code discovers skills via `--add-dir` inside live container | SKILL-03 | Requires running Claude Code agent in Docker | Run `forgectl run` with a skill-enabled workflow, verify agent output references skill content |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
