---
phase: 20
slug: schema-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 20 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^2.0.0 |
| **Config file** | vitest.config.ts |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npm test -- --reporter=verbose test/unit/storage-migrator.test.ts test/unit/storage-runs-repo.test.ts` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npm test -- storage-migrator storage-runs-repo`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 20-01-01 | 01 | 1 | SC-1 | integration | `FORGECTL_SKIP_DOCKER=true npm test -- storage-migrator` | ✅ (needs new assertions) | ⬜ pending |
| 20-01-02 | 01 | 1 | SC-2 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- storage-delegations-repo` | ❌ W0 | ⬜ pending |
| 20-01-03 | 01 | 1 | SC-3 | unit | `FORGECTL_SKIP_DOCKER=true npm test -- pipeline-dag` | ✅ (needs new YAML cases) | ⬜ pending |
| 20-01-04 | 01 | 1 | SC-4 | build check | `npm run typecheck && npm run lint` | ✅ | ⬜ pending |
| 20-01-05 | 01 | 1 | SC-5 | full suite | `FORGECTL_SKIP_DOCKER=true npm test` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/storage-delegations-repo.test.ts` — stubs for SC-2 (all 7 repository methods)
- [ ] Add assertions to `test/unit/storage-migrator.test.ts` — verify `delegations` table exists after migration

*Existing pipeline-dag.test.ts covers SC-3 once new YAML fields are tested in place.*

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
