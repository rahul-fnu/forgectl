---
phase: 14
slug: github-app
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 14 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.x |
| **Config file** | vitest.config.ts |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/github` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/github`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 14-01-01 | 01 | 1 | GHAP-01 | unit | `npx vitest run test/unit/github-webhooks.test.ts -t "HMAC"` | Wave 0 | ⬜ pending |
| 14-01-02 | 01 | 1 | GHAP-02 | unit | `npx vitest run test/unit/github-webhooks.test.ts -t "trigger"` | Wave 0 | ⬜ pending |
| 14-02-01 | 02 | 1 | GHAP-04 | unit | `npx vitest run test/unit/github-commands.test.ts` | Wave 0 | ⬜ pending |
| 14-02-02 | 02 | 1 | GHAP-05 | unit | `npx vitest run test/unit/github-permissions.test.ts` | Wave 0 | ⬜ pending |
| 14-03-01 | 03 | 2 | GHAP-03 | unit | `npx vitest run test/unit/github-comments.test.ts` | Wave 0 | ⬜ pending |
| 14-03-02 | 03 | 2 | GHAP-07 | unit | `npx vitest run test/unit/github-reactions.test.ts` | Wave 0 | ⬜ pending |
| 14-04-01 | 04 | 3 | GHAP-06 | unit | `npx vitest run test/unit/github-clarification.test.ts` | Wave 0 | ⬜ pending |
| 14-04-02 | 04 | 3 | GHAP-08 | unit | `npx vitest run test/unit/github-checks.test.ts` | Wave 0 | ⬜ pending |
| 14-04-03 | 04 | 3 | GHAP-09 | unit | `npx vitest run test/unit/github-pr-description.test.ts` | Wave 0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/github-webhooks.test.ts` — stubs for GHAP-01, GHAP-02
- [ ] `test/unit/github-commands.test.ts` — stubs for GHAP-04
- [ ] `test/unit/github-permissions.test.ts` — stubs for GHAP-05
- [ ] `test/unit/github-comments.test.ts` — stubs for GHAP-03
- [ ] `test/unit/github-reactions.test.ts` — stubs for GHAP-07
- [ ] `test/unit/github-checks.test.ts` — stubs for GHAP-08
- [ ] `test/unit/github-clarification.test.ts` — stubs for GHAP-06
- [ ] `test/unit/github-pr-description.test.ts` — stubs for GHAP-09

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real GitHub webhook delivery | GHAP-01 | Requires live GitHub App + smee.io/ngrok | Configure app, push event, verify daemon receives and processes |
| End-to-end slash command flow | GHAP-04 | Requires actual GitHub comment event | Post `/forgectl run` comment on test issue, verify run dispatched |
| PR check run lifecycle | GHAP-08 | Requires live PR with commit SHA | Create test PR, verify check run appears and transitions |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
