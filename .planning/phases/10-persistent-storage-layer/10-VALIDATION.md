---
phase: 10
slug: persistent-storage-layer
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-09
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.x |
| **Config file** | vitest.config.ts |
| **Quick run command** | `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/storage` |
| **Full suite command** | `FORGECTL_SKIP_DOCKER=true npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `FORGECTL_SKIP_DOCKER=true npx vitest run test/unit/storage*.test.ts`
- **After every plan wave:** Run `FORGECTL_SKIP_DOCKER=true npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 10-01-01 | 01 | 1 | STOR-01 | unit | `npx vitest run test/unit/storage-database.test.ts -t "creates database"` | ❌ W0 | ⬜ pending |
| 10-01-02 | 01 | 1 | STOR-01 | unit | `npx vitest run test/unit/storage-database.test.ts -t "drizzle instance"` | ❌ W0 | ⬜ pending |
| 10-01-03 | 01 | 1 | STOR-02 | unit | `npx vitest run test/unit/storage-migrator.test.ts -t "runs migrations"` | ❌ W0 | ⬜ pending |
| 10-01-04 | 01 | 1 | STOR-02 | unit | `npx vitest run test/unit/storage-migrator.test.ts -t "idempotent"` | ❌ W0 | ⬜ pending |
| 10-02-01 | 02 | 2 | STOR-03 | unit | `npx vitest run test/unit/storage-runs-repo.test.ts` | ❌ W0 | ⬜ pending |
| 10-02-02 | 02 | 2 | STOR-03 | unit | `npx vitest run test/unit/storage-pipelines-repo.test.ts` | ❌ W0 | ⬜ pending |
| 10-02-03 | 02 | 2 | STOR-03 | unit | `npx vitest run test/unit/daemon.test.ts -t "persistent"` | ❌ W0 | ⬜ pending |
| 10-02-04 | 02 | 2 | STOR-03 | integration | `npx vitest run test/unit/daemon-integration.test.ts` | Existing (update) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/unit/storage-database.test.ts` — stubs for STOR-01 (database creation, WAL, config path)
- [ ] `test/unit/storage-migrator.test.ts` — stubs for STOR-02 (migration execution, idempotency)
- [ ] `test/unit/storage-runs-repo.test.ts` — stubs for STOR-03 (run CRUD via repository)
- [ ] `test/unit/storage-pipelines-repo.test.ts` — stubs for STOR-03 (pipeline CRUD via repository)
- [ ] Install: `npm install drizzle-orm better-sqlite3 && npm install -D drizzle-kit @types/better-sqlite3`
- [ ] Update `tsup.config.ts` to externalize `better-sqlite3` and copy migrations

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
