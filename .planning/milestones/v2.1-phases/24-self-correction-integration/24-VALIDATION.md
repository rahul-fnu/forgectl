---
phase: 24
slug: self-correction-integration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-13
---

# Phase 24 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing, all tests use vitest) |
| **Config file** | vitest.config.ts |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npm test -- --reporter=verbose test/unit/pipeline-self-correction.test.ts` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npm test -- test/unit/pipeline-self-correction.test.ts test/unit/pipeline-loop.test.ts test/unit/pipeline-executor.test.ts`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 24-01-01 | 01 | 1 | CORR-01 | unit | `npm test -- test/unit/pipeline-self-correction.test.ts` | ❌ W0 | ⬜ pending |
| 24-01-02 | 01 | 1 | CORR-02 | unit | `npm test -- test/unit/pipeline-self-correction.test.ts` | ❌ W0 | ⬜ pending |
| 24-01-03 | 01 | 1 | CORR-03 | unit | `npm test -- test/unit/pipeline-loop.test.ts` | ✅ | ⬜ pending |
| 24-01-04 | 01 | 1 | CORR-04 | unit | `npm test -- test/unit/pipeline-self-correction.test.ts` | ❌ W0 | ⬜ pending |
| 24-01-05 | 01 | 1 | CORR-05 | unit | `npm test -- test/unit/pipeline-self-correction.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/pipeline-self-correction.test.ts` — stubs for CORR-01, CORR-02, CORR-04, CORR-05
- [ ] `src/validation/runner.ts` — needs `lastOutput?: string` added to `ValidationResult` and populated in `runValidationLoop`

*CORR-03 is already covered by `test/unit/pipeline-loop.test.ts` progressive context test — no gap*

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
