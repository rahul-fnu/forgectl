# Deferred Items — Phase 20

## Out-of-scope issues discovered during execution

### 1. Missing ESLint configuration file

**Found during:** Task 2 (lint verification)
**Issue:** `npm run lint` fails because no `eslint.config.js` (or `.eslintrc.*`) file exists in the project root. ESLint v9 requires a flat config file. This is a pre-existing issue unrelated to Phase 20 changes.
**Evidence:** `git log --grep="eslint"` returns no results — the config file was never committed.
**Impact:** Low — TypeScript typecheck (`npm run typecheck`) passes cleanly, which is the authoritative correctness check. ESLint is a style/lint tool.
**Recommendation:** Create `eslint.config.js` with TypeScript ESLint flat config in a future maintenance plan.
