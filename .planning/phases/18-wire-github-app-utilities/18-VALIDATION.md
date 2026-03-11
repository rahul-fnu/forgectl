---
phase: 18
slug: wire-github-app-utilities
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-11
---

# Phase 18 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.1.9 |
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
| 18-01-01 | 01 | 1 | GHAP-03 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/wiring-comments.test.ts -x` | ❌ W0 | ⬜ pending |
| 18-01-02 | 01 | 1 | GHAP-03 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/github-comments.test.ts -x` | ✅ | ⬜ pending |
| 18-01-03 | 01 | 1 | GHAP-08 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/wiring-checks.test.ts -x` | ❌ W0 | ⬜ pending |
| 18-01-04 | 01 | 1 | GHAP-09 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/wiring-pr-description.test.ts -x` | ❌ W0 | ⬜ pending |
| 18-01-05 | 01 | 1 | GHAP-07 | manual | N/A | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/wiring-comments.test.ts` — tests comment consolidation and progress comment wiring
- [ ] `test/unit/wiring-checks.test.ts` — tests check run lifecycle wiring into worker
- [ ] `test/unit/wiring-pr-description.test.ts` — tests PR description generation wiring

*Existing tests: github-comments.test.ts (17 tests), github-checks.test.ts, github-pr-description.test.ts cover the utility modules themselves.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Reaction handler registered but not webhook-triggerable | GHAP-07 | GitHub API has no reaction webhook events | Verify handleReactionEvent exists and is exported; verify documentation notes limitation |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
