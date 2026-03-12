---
phase: 17
slug: wire-governance-gates
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-11
---

# Phase 17 — Validation Strategy

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
| 17-01-01 | 01 | 1 | GOVN-01 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/governance-wiring.test.ts -x` | ❌ W0 | ⬜ pending |
| 17-01-02 | 01 | 1 | GOVN-01 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/resolver.test.ts -x` | ✅ | ⬜ pending |
| 17-01-03 | 01 | 1 | GOVN-02 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/governance-wiring.test.ts -x` | ❌ W0 | ⬜ pending |
| 17-01-04 | 01 | 1 | GOVN-02 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/governance-wiring.test.ts -x` | ❌ W0 | ⬜ pending |
| 17-01-05 | 01 | 1 | GOVN-03 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/governance-rules.test.ts -x` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/governance-wiring.test.ts` — stubs for GOVN-01, GOVN-02, GOVN-03 wiring verification
- Existing governance tests (autonomy, approval, rules, routes) should continue to pass unchanged

*Existing infrastructure covers most phase requirements. One new test file needed.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
