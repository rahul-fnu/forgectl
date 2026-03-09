---
phase: 9
slug: fix-github-id-identifier-mismatch
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 9 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (latest) |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npx vitest --run` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npx vitest --run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npx vitest --run`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npx vitest --run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 09-01-01 | 01 | 1 | R1.2 | unit | `npx vitest --run test/unit/tracker-github.test.ts` | Exists, needs update | ⬜ pending |
| 09-01-02 | 01 | 1 | R1.2 | unit | `npx vitest --run test/unit/tracker-github.test.ts` | Wave 0 (new tests) | ⬜ pending |
| 09-01-03 | 01 | 1 | R1.2 | unit | `npx vitest --run test/unit/tracker-github.test.ts` | Exists, update assertions | ⬜ pending |
| 09-02-01 | 02 | 2 | R7.3 | integration | `npx vitest --run test/integration/cross-phase-id.test.ts` | Wave 0 (new file) | ⬜ pending |
| 09-02-02 | 02 | 2 | R7.3 | unit | `npx vitest --run test/unit/orchestrator-dispatcher.test.ts` | Exists, update mocks | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/tracker-github.test.ts` — new tests for parseIssueNumber with "42" format and NaN guard
- [ ] `test/integration/cross-phase-id.test.ts` — new file covering dispatcher → tracker mutation ID correctness

*Existing infrastructure covers framework setup — vitest already configured.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| E2E: GitHub issue → dispatch → comment → close | R7.3 | Requires real GitHub API or mock HTTP server | Automated E2E test with mocked GitHub API in test/e2e/ |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
