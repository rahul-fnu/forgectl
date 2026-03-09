---
phase: 4
slug: agent-session-abstraction
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^2.0.0 |
| **Config file** | vitest.config.ts |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/session.test.ts test/unit/appserver-session.test.ts` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/session.test.ts test/unit/appserver-session.test.ts`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | R5.1 | unit | `npx vitest run test/unit/session.test.ts -t "factory"` | No — W0 | ⬜ pending |
| 04-01-02 | 01 | 1 | R5.1 | unit | `npx vitest run test/unit/session.test.ts -t "result"` | No — W0 | ⬜ pending |
| 04-02-01 | 02 | 1 | R5.2 | unit | `npx vitest run test/unit/session.test.ts -t "oneshot"` | No — W0 | ⬜ pending |
| 04-02-02 | 02 | 1 | R5.2 | unit | `npx vitest run test/unit/session.test.ts -t "activity"` | No — W0 | ⬜ pending |
| 04-02-03 | 02 | 1 | R5.2 | unit | `npx vitest run test/unit/session.test.ts -t "backward"` | No — W0 | ⬜ pending |
| 04-03-01 | 03 | 2 | R5.3 | unit | `npx vitest run test/unit/appserver-session.test.ts -t "handshake"` | No — W0 | ⬜ pending |
| 04-03-02 | 03 | 2 | R5.3 | unit | `npx vitest run test/unit/appserver-session.test.ts -t "turn"` | No — W0 | ⬜ pending |
| 04-03-03 | 03 | 2 | R5.3 | unit | `npx vitest run test/unit/appserver-session.test.ts -t "approval"` | No — W0 | ⬜ pending |
| 04-03-04 | 03 | 2 | R5.3 | unit | `npx vitest run test/unit/appserver-session.test.ts -t "multi-turn"` | No — W0 | ⬜ pending |
| 04-03-05 | 03 | 2 | R5.3 | unit | `npx vitest run test/unit/appserver-session.test.ts -t "token"` | No — W0 | ⬜ pending |
| 04-04-01 | 04 | 2 | R5.4 | unit | `npx vitest run test/unit/session.test.ts -t "lifecycle"` | No — W0 | ⬜ pending |
| 04-04-02 | 04 | 2 | R5.4 | unit | `npx vitest run test/unit/session.test.ts -t "closed"` | No — W0 | ⬜ pending |
| 04-04-03 | 04 | 2 | R5.4 | unit | `npx vitest run test/unit/session.test.ts -t "heartbeat"` | No — W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/session.test.ts` — stubs for R5.1, R5.2, R5.4 (factory, oneshot, lifecycle)
- [ ] `test/unit/appserver-session.test.ts` — stubs for R5.3 (JSON-RPC protocol, handshake, turns)
- [ ] Mock helpers for Docker container exec stream (bidirectional stream mock)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Docker exec bidirectional stream | R5.3 | Requires running Docker daemon | Start Codex app-server in container, verify JSON-RPC handshake completes |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
