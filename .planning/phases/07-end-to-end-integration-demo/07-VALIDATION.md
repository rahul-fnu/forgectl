---
phase: 7
slug: end-to-end-integration-demo
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npx vitest run` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npx vitest run`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 7-01-01 | 01 | 1 | R7.1 | unit | `npx vitest run test/unit/workflow-file.test.ts -x` | ✅ (extend) | ⬜ pending |
| 7-01-02 | 01 | 1 | R7.2 | unit | `npx vitest run test/unit/orchestrator-worker.test.ts -x` | ✅ (extend) | ⬜ pending |
| 7-01-03 | 01 | 1 | R7.3 | unit | `npx vitest run test/unit/orchestrator-dispatcher.test.ts -x` | ✅ (extend) | ⬜ pending |
| 7-02-01 | 02 | 2 | NF1 | integration | `npx vitest run test/integration/backward-compat.test.ts -x` | ❌ W0 | ⬜ pending |
| 7-03-01 | 03 | 2 | R7.2, R7.3 | integration | `npx vitest run test/integration/e2e-orchestration.test.ts -x` | ❌ W0 | ⬜ pending |
| 7-03-02 | 03 | 2 | R7.4 | unit | `npx vitest run test/unit/orchestrator-reconciler.test.ts -x` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/integration/e2e-orchestration.test.ts` — E2E orchestrator flow with mock GitHub API
- [ ] `test/integration/backward-compat.test.ts` — verify `forgectl run` plan resolution still works

*Existing test infrastructure covers unit test needs — extend existing files.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Demo script walkthrough | R7.1 | End-user experience | Follow demo script, verify output matches documentation |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
