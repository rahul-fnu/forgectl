---
phase: 22
slug: loop-pipeline-nodes
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-13
---

# Phase 22 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (project standard) |
| **Config file** | vitest.config.ts (project root) |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/pipeline-loop.test.ts` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/pipeline-loop.test.ts`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 22-01-01 | 01 | 1 | LOOP-01 | unit | `npm test -- test/unit/pipeline-loop.test.ts` | ❌ W0 | ⬜ pending |
| 22-01-02 | 01 | 1 | LOOP-01 | unit | `npm test -- test/unit/pipeline-loop.test.ts` | ❌ W0 | ⬜ pending |
| 22-01-03 | 01 | 1 | LOOP-02 | unit | `npm test -- test/unit/pipeline-dag.test.ts` | ✅ (extend) | ⬜ pending |
| 22-01-04 | 01 | 1 | LOOP-03 | unit | `npm test -- test/unit/pipeline-loop.test.ts` | ❌ W0 | ⬜ pending |
| 22-01-05 | 01 | 1 | LOOP-04 | unit | `npm test -- test/unit/pipeline-loop.test.ts` | ❌ W0 | ⬜ pending |
| 22-01-06 | 01 | 1 | LOOP-05 | unit | `npm test -- test/unit/pipeline-loop.test.ts` | ❌ W0 | ⬜ pending |
| 22-01-07 | 01 | 1 | LOOP-01+LOOP-03 | unit | `npm test -- test/unit/pipeline-loop.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/pipeline-loop.test.ts` — stubs for LOOP-01, LOOP-03, LOOP-04, LOOP-05
- [ ] Extend `test/unit/pipeline-dag.test.ts` — loop node DAG validation cases (LOOP-02)

*Existing test infrastructure is complete — only the new loop test file is missing.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
