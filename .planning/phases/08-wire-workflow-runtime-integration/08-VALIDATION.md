---
phase: 8
slug: wire-workflow-runtime-integration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npx vitest run --reporter=dot` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npx vitest run --reporter=dot`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 08-01-01 | 01 | 1 | R4.3 | unit | `npx vitest run test/unit/daemon-watcher.test.ts -x` | ❌ W0 | ⬜ pending |
| 08-01-02 | 01 | 1 | R4.3 | unit | `npx vitest run test/unit/daemon-watcher.test.ts -x` | ❌ W0 | ⬜ pending |
| 08-01-03 | 01 | 1 | R4.3 | unit | `npx vitest run test/unit/orchestrator-reload.test.ts -x` | ❌ W0 | ⬜ pending |
| 08-02-01 | 02 | 1 | R4.4 | unit | `npx vitest run test/unit/daemon-config-merge.test.ts -x` | ❌ W0 | ⬜ pending |
| 08-02-02 | 02 | 1 | R4.4 | unit | `npx vitest run test/unit/workflow-merge.test.ts -x` | ✅ | ⬜ pending |
| 08-02-03 | 02 | 1 | R4.4 | unit | `npx vitest run test/unit/daemon-config-merge.test.ts -x` | ❌ W0 | ⬜ pending |
| 08-03-01 | 03 | 2 | R4.3+R4.4 | integration | `npx vitest run test/unit/daemon-integration.test.ts -x` | ❌ W0 | ⬜ pending |
| 08-03-02 | 03 | 2 | R4.3 | integration | `npx vitest run test/unit/daemon-integration.test.ts -x` | ❌ W0 | ⬜ pending |
| 08-03-03 | 03 | 2 | R4.3 | integration | `npx vitest run test/unit/daemon-integration.test.ts -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/daemon-watcher.test.ts` — stubs for R4.3 watcher lifecycle in daemon
- [ ] `test/unit/orchestrator-reload.test.ts` — stubs for R4.3 reload propagation
- [ ] `test/unit/daemon-config-merge.test.ts` — stubs for R4.4 four-layer merge at startup
- [ ] `test/unit/daemon-integration.test.ts` — stubs for R4.3+R4.4 integration with adapters

*Existing infrastructure covers framework install.*

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
