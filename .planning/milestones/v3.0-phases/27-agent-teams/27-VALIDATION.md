---
phase: 27
slug: agent-teams
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-13
---

# Phase 27 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (latest, already configured) |
| **Config file** | vitest.config.ts (root) |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-state.test.ts test/unit/workflow-resolver.test.ts test/unit/workflow-file.test.ts` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-state.test.ts test/unit/workflow-resolver.test.ts test/unit/workflow-file.test.ts`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 27-01-01 | 01 | 1 | TEAM-02, TEAM-05 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/workflow-file.test.ts -x` | extend | pending |
| 27-01-02 | 01 | 1 | TEAM-02, TEAM-05 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/workflow-resolver.test.ts -x` | extend | pending |
| 27-02-01 | 02 | 2 | TEAM-03 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/orchestrator-state.test.ts -x` | extend | pending |
| 27-02-02 | 02 | 2 | TEAM-01, TEAM-04 | unit | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/agent-team-env.test.ts test/unit/agent-team-checkpoint.test.ts -x` | W0 | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/agent-team-env.test.ts` — stubs for TEAM-01 (env var injection, warn-and-skip for non-claude-code, noTeam bypass)
- [ ] `test/unit/agent-team-checkpoint.test.ts` — stubs for TEAM-04 (saveCheckpoint gating via skipCheckpoints flag)

*Existing test files for TEAM-02, TEAM-03, TEAM-05 will be extended with new `it()` cases rather than creating new files.*

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
