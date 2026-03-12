---
phase: 19
slug: wire-post-gate-worker
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 19 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-worker.test.ts` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-worker.test.ts`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 19-01-01 | 01 | 1 | GOVN-01 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-worker.test.ts` | ❌ W0 | ⬜ pending |
| 19-01-02 | 01 | 1 | GOVN-02 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-worker.test.ts` | ❌ W0 | ⬜ pending |
| 19-01-03 | 01 | 1 | GOVN-01 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-worker.test.ts` | ❌ W0 | ⬜ pending |
| 19-01-04 | 01 | 1 | GOVN-02 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-worker.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] New test cases in `test/unit/orchestrator-worker.test.ts` for post-gate in worker path
- [ ] Test: executeWorker calls enterPendingOutputApproval when autonomy is "interactive" and runRepo available
- [ ] Test: executeWorker skips post-gate when autonomy is "full"
- [ ] Test: executeWorker auto-approves when evaluateAutoApprove returns true
- [ ] Test: executeWorker still completes cleanup after entering pending approval

*Existing infrastructure covers framework/fixture needs.*

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
