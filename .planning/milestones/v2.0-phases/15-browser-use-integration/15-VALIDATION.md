---
phase: 15
slug: browser-use-integration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 15 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/browser-use` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/browser-use-session.test.ts test/unit/session.test.ts -x`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 15-01-01 | 01 | 1 | BROW-01 | unit | `npx vitest run test/unit/browser-use-session.test.ts -x` | ❌ W0 | ⬜ pending |
| 15-01-02 | 01 | 1 | BROW-01 | unit | `npx vitest run test/unit/session.test.ts -x` | ✅ needs update | ⬜ pending |
| 15-01-03 | 01 | 1 | BROW-01 | unit | `npx vitest run test/unit/config.test.ts -x` | ✅ needs update | ⬜ pending |
| 15-01-04 | 01 | 1 | BROW-01 | unit | `npx vitest run test/unit/browser-use-session.test.ts -x` | ❌ W0 | ⬜ pending |
| 15-02-01 | 02 | 1 | BROW-02 | unit | `npx vitest run test/unit/browser-use-sidecar.test.ts -x` | ❌ W0 | ⬜ pending |
| 15-02-02 | 02 | 1 | BROW-02 | integration | `docker build -f dockerfiles/Dockerfile.research-browser .` | manual | ⬜ pending |
| 15-02-03 | 02 | 1 | BROW-03 | unit | `npx vitest run test/unit/workflows.test.ts -x` | ✅ needs update | ⬜ pending |
| 15-02-04 | 02 | 1 | BROW-03 | unit | `npx vitest run test/unit/browser-use-workflow.test.ts -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/browser-use-session.test.ts` — stubs for BROW-01 (session lifecycle, health polling, task invocation)
- [ ] `test/unit/browser-use-sidecar.test.ts` — stubs for BROW-02 (sidecar API contract tests, mock HTTP)
- [ ] `test/unit/browser-use-workflow.test.ts` — stubs for BROW-03 (workflow definition, validation steps)
- [ ] Update `test/unit/session.test.ts` — add browser-use branch to factory tests
- [ ] Update `test/unit/workflows.test.ts` — verify browser-research in BUILTINS

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Dockerfile builds and runs Chromium | BROW-02 | Needs Docker daemon | `docker build -f dockerfiles/Dockerfile.research-browser .` then run container and verify sidecar starts |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
