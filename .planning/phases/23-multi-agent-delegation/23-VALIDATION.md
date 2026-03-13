---
phase: 23
slug: multi-agent-delegation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-13
---

# Phase 23 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (project standard) |
| **Config file** | vitest.config.ts (project root) |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/delegation*.test.ts test/unit/orchestrator-slots-two-tier.test.ts` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~20 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/delegation*.test.ts test/unit/orchestrator-slots-two-tier.test.ts`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 20 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 23-01-01 | 01 | 1 | DELEG-06 | unit | `npx vitest run test/unit/orchestrator-slots-two-tier.test.ts` | ❌ W0 | ⬜ pending |
| 23-01-02 | 01 | 1 | DELEG-01, DELEG-04, DELEG-05 | unit | `npx vitest run test/unit/delegation-manifest.test.ts test/unit/delegation-manager.test.ts` | ❌ W0 | ⬜ pending |
| 23-02-01 | 02 | 2 | DELEG-02, DELEG-03, DELEG-08 | unit | `npx vitest run test/unit/delegation-manager.test.ts` | ❌ W0 | ⬜ pending |
| 23-03-01 | 03 | 3 | DELEG-07, DELEG-09 | unit | `npx vitest run test/unit/delegation-manager.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/delegation-manifest.test.ts` — stubs for DELEG-01 (manifest parsing, Zod validation, first-block-only)
- [ ] `test/unit/delegation-manager.test.ts` — stubs for DELEG-02, DELEG-03, DELEG-04, DELEG-05, DELEG-07, DELEG-08, DELEG-09
- [ ] `test/unit/orchestrator-slots-two-tier.test.ts` — stubs for DELEG-06 (TwoTierSlotManager, disabled when child_slots=0)

*Existing test infrastructure is complete — only the new delegation test files are missing.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 20s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
