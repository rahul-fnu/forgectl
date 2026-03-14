---
phase: 21
slug: conditional-pipeline-nodes
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-13
---

# Phase 21 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^2.0.0 |
| **Config file** | vitest.config.ts |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/pipeline-executor.test.ts test/unit/pipeline-condition.test.ts` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/pipeline-executor.test.ts test/unit/pipeline-condition.test.ts`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 21-01-01 | 01 | 1 | COND-01 | unit | `npx vitest run test/unit/pipeline-condition.test.ts` | ❌ W0 | ⬜ pending |
| 21-01-02 | 01 | 1 | COND-01 | unit | `npx vitest run test/unit/pipeline-condition.test.ts` | ❌ W0 | ⬜ pending |
| 21-01-03 | 01 | 1 | COND-04 | unit | `npx vitest run test/unit/pipeline-condition.test.ts` | ❌ W0 | ⬜ pending |
| 21-01-04 | 01 | 1 | COND-04 | unit | `npx vitest run test/unit/pipeline-condition.test.ts` | ❌ W0 | ⬜ pending |
| 21-01-05 | 01 | 1 | COND-04 | unit | `npx vitest run test/unit/pipeline-condition.test.ts` | ❌ W0 | ⬜ pending |
| 21-02-01 | 02 | 1 | COND-02 | unit | `npx vitest run test/unit/pipeline-executor.test.ts` | ✅ | ⬜ pending |
| 21-02-02 | 02 | 1 | COND-02 | unit | `npx vitest run test/unit/pipeline-executor.test.ts` | ✅ | ⬜ pending |
| 21-02-03 | 02 | 1 | COND-03 | unit | `npx vitest run test/unit/pipeline-executor.test.ts` | ✅ extend | ⬜ pending |
| 21-02-04 | 02 | 1 | COND-05 | unit | `npx vitest run test/unit/pipeline-executor.test.ts` | ✅ extend | ⬜ pending |
| 21-02-05 | 02 | 1 | COND-05 | unit | `npx vitest run test/unit/pipeline-executor.test.ts` | ✅ extend | ⬜ pending |
| 21-02-06 | 02 | 1 | COND-06 | unit | `npx vitest run test/unit/pipeline-executor.test.ts` | ✅ extend | ⬜ pending |
| 21-02-07 | 02 | 1 | COND-07 | unit | `npx vitest run test/unit/pipeline-executor.test.ts` | ✅ extend | ⬜ pending |
| 21-02-08 | 02 | 1 | COND-07 | unit | `npx vitest run test/unit/pipeline-executor.test.ts` | ✅ extend | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/pipeline-condition.test.ts` — stubs for COND-01, COND-04 (evaluateCondition, shorthand expansion, mutual exclusivity)

*Existing `test/unit/pipeline-executor.test.ts` covers COND-02 base cases; needs extension for COND-03, COND-05, COND-06, COND-07 but file already exists.*

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
