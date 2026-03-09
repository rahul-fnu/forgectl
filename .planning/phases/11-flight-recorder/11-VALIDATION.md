---
phase: 11
slug: flight-recorder
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-09
---

# Phase 11 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/storage-events.test.ts test/unit/storage-snapshots.test.ts` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run quick run command (event + snapshot tests)
- **After every plan wave:** Run full suite command
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 11-01-01 | 01 | 1 | AUDT-01 | unit | `npx vitest run test/unit/storage-events.test.ts` | ❌ W0 | ⬜ pending |
| 11-01-02 | 01 | 1 | AUDT-04 | unit | `npx vitest run test/unit/storage-snapshots.test.ts` | ❌ W0 | ⬜ pending |
| 11-02-01 | 02 | 2 | AUDT-02 | unit | `npx vitest run test/unit/cli-inspect.test.ts` | ❌ W0 | ⬜ pending |
| 11-02-02 | 02 | 2 | AUDT-03 | unit | `npx vitest run test/unit/orchestrator-comment.test.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/storage-events.test.ts` — stubs for AUDT-01 (event recording)
- [ ] `test/unit/storage-snapshots.test.ts` — stubs for AUDT-04 (state snapshots)
- [ ] `test/unit/cli-inspect.test.ts` — stubs for AUDT-02 (inspect command)

*Existing test infrastructure covers framework needs. Only test file stubs needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| GitHub comment formatting | AUDT-03 | Visual verification of markdown rendering | Post a comment to a test issue and verify formatting |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
