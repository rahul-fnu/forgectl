---
phase: 12
slug: durable-execution
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 12 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npx vitest run --reporter=verbose` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npx vitest run --reporter=verbose`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 12-01-XX | 01 | 1 | DURA-04 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/durability-locks.test.ts -x` | ❌ W0 | ⬜ pending |
| 12-02-XX | 02 | 1 | DURA-01, DURA-02 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/durability-checkpoint.test.ts test/unit/durability-recovery.test.ts -x` | ❌ W0 | ⬜ pending |
| 12-03-XX | 03 | 2 | DURA-03 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/durability-pause.test.ts -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/durability-locks.test.ts` — stubs for DURA-04 (execution locks)
- [ ] `test/unit/durability-checkpoint.test.ts` — stubs for DURA-02 (checkpoint/resume)
- [ ] `test/unit/durability-recovery.test.ts` — stubs for DURA-01 (startup recovery)
- [ ] `test/unit/durability-pause.test.ts` — stubs for DURA-03 (pause/resume)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Daemon crash recovery with real containers | DURA-01 | Requires actual daemon process kill + restart with Docker | 1. Start a run, 2. Kill daemon (SIGKILL), 3. Restart daemon, 4. Verify run marked interrupted or resumed |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
