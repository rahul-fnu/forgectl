---
phase: 3
slug: workflow-contract
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/workflow-file` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/workflow-file`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | R4.1 | unit | `npx vitest run test/unit/workflow-file` | ❌ W0 | ⬜ pending |
| 03-01-02 | 01 | 1 | R4.2 | unit | `npx vitest run test/unit/workflow-file` | ❌ W0 | ⬜ pending |
| 03-02-01 | 02 | 1 | R4.3 | unit | `npx vitest run test/unit/workflow-watcher` | ❌ W0 | ⬜ pending |
| 03-02-02 | 02 | 1 | R4.4 | unit | `npx vitest run test/unit/workflow-file` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/workflow-file.test.ts` — stubs for R4.1, R4.2, R4.4
- [ ] `test/unit/workflow-watcher.test.ts` — stubs for R4.3

*Existing infrastructure covers framework and fixture requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| File watcher reacts to real edits | R4.3 | Requires actual filesystem events | Save WORKFLOW.md and observe reload log |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
