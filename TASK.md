# TASK: Complete forgectl — Phase 6 Dashboard + Phase 7 Polish + Full E2E Verification

You are finishing forgectl, a CLI + daemon that runs AI agents in isolated Docker containers. The core engine works end-to-end (Phases 1-5 are complete and tested). Your job is to build the web dashboard, polish the project, and verify everything works.

**Read SPEC.md first** — it contains the full architecture, all workflow definitions, and the dashboard spec.

**IMPORTANT: This is an unattended overnight run. You must be thorough and self-verifying. After each phase, run tests and verify your work before moving on. At the end, run a comprehensive E2E verification. Do NOT leave anything broken.**

---

## Phase 6: Web Dashboard

Build a React dashboard served by the daemon at http://127.0.0.1:4857. The daemon already has a REST API at :4856 with these endpoints:

```
GET  /health                → { status: "ok" }
POST /runs                  → Submit a run (body: { task, workflow?, input?, agent? })
GET  /runs                  → List all runs
GET  /runs/:id              → Get run details
GET  /runs/:id/events       → SSE stream of run events
```

Events are typed: `started | phase | validation | retry | output | completed | failed`

### 6A: Project Setup

Create the dashboard as a single-page React app that gets bundled and served by the daemon as static files.

**Option 1 (simpler, preferred):** Build as a single `src/ui/index.html` file with inline React via CDN (React, ReactDOM, Tailwind CDN). The daemon serves this file directly. No Vite build step needed.

**Option 2:** If you prefer a proper build pipeline, use Vite with React+TypeScript, output to `dist/ui/`, and have the daemon serve from there. But Option 1 is fine for V1.

The daemon server (`src/daemon/server.ts`) needs to be updated to serve the UI. Add a static file route:

```typescript
// Serve dashboard UI
import { join } from "node:path";
app.register(import("@fastify/static"), {
  root: join(import.meta.dirname, "ui"),  // or wherever the built UI lives
  prefix: "/",
});
```

Or for the simpler approach, just serve the single HTML file at `/` and `/ui`.

### 6B: Dashboard Page

The main dashboard at `/` shows:

1. **Active Runs** — cards for currently running tasks showing: task name, workflow type, agent, elapsed time, current phase (prepare/execute/validate/output), live validation status
2. **Recent Runs** — last 10 completed runs showing: task, workflow, status (success/failed), duration, files changed
3. **Quick Submit** — form to submit a new run: task (textarea), workflow (dropdown: code/research/content/data/ops/general), agent (dropdown: claude-code/codex), repo path or input files, submit button

Data comes from `GET /runs` (poll every 3s for active runs, or use SSE).

### 6C: Run View Page

Clicking a run card navigates to `/runs/:id` showing:

1. **Header** — run ID, task, workflow, agent, status badge, duration
2. **Live Log** — SSE connection to `/runs/:id/events`, streaming log entries in a terminal-style scrolling view. Color-code by type: phase headers in blue, validation pass in green, failures in red, agent output in white
3. **Validation Progress** — visual checklist of validation steps, updating live as each completes
4. **Output Preview** — after completion, show the output: for git mode, show the branch name and diff stats; for files mode, list output files

### 6D: History Page

`/history` — filterable table of all runs:
- Columns: Run ID, Task, Workflow, Agent, Status, Duration, Date
- Filters: workflow type dropdown, status dropdown (all/success/failed), date range
- Click row → navigate to run view

### 6E: Settings Page

`/settings` — show:
- Auth status: which providers are configured (read from a new `/auth/status` API endpoint)
- Daemon info: uptime, port, version

Add a new route to `src/daemon/routes.ts`:
```typescript
app.get("/auth/status", async () => {
  const claude = await getClaudeAuth();
  const codex = await getCodexAuth();
  return {
    claude: claude ? { type: claude.type, configured: true } : { configured: false },
    codex: codex ? { type: codex.type, configured: true } : { configured: false },
  };
});
```

### 6F: Styling

Use Tailwind CSS (CDN is fine). Design should be:
- Dark theme (dark gray backgrounds, white text, colored accents)
- Clean, minimal, developer-focused
- Responsive but optimized for desktop
- Status colors: green for success, red for failed, blue for running, gray for queued

### 6G: Wire Up Daemon

Update `src/daemon/server.ts` to:
1. Serve the dashboard UI at the root path
2. Add the `/auth/status` endpoint
3. Add CORS headers for local development

### Verification for Phase 6:
```bash
npm run build
forgectl up --foreground &
sleep 2
# Test API
curl http://127.0.0.1:4856/health
curl http://127.0.0.1:4856/auth/status
# Test UI serves
curl -s http://127.0.0.1:4856/ | head -5  # Should return HTML
forgectl down
```

---

## Phase 7: Polish

### 7A: README

Create a comprehensive `README.md` with:
- What forgectl is (one paragraph)
- Quick start (install, auth setup, first run)
- Usage examples for each workflow type (code, research, content, data, ops)
- Configuration reference
- Custom workflows guide
- Dashboard screenshot placeholder
- Architecture overview (text, not image)

### 7B: Cleanup

- Remove any debug logging, TODO comments, or dead code
- Ensure all TypeScript compiles cleanly: `npm run typecheck`
- Ensure all tests pass: `npm test`
- Ensure build is clean: `npm run build`

### 7C: Missing Small Features

Check if these work and fix if broken:
- `forgectl init` — generates a starter `.forgectl/config.yaml`
- `forgectl workflows list` — lists all built-in workflows
- `forgectl workflows show code` — shows the code workflow definition
- `forgectl auth list` — shows configured credentials

---

## Phase 8: Full E2E Verification (CRITICAL — DO NOT SKIP)

**This is the most important phase. You MUST run these verifications and fix any issues before finishing.**

### 8A: Unit Tests
```bash
npm run typecheck
npm test
```
ALL tests must pass. Fix any failures.

### 8B: Build Verification
```bash
npm run build
node dist/index.js --help
node dist/index.js workflows list
node dist/index.js auth list
```

### 8C: Dry Run Test
```bash
rm -rf /tmp/forge-test && mkdir /tmp/forge-test && cd /tmp/forge-test
git init
cat > package.json << 'EOF'
{"name":"forge-test","scripts":{"lint":"echo ok","typecheck":"echo ok","test":"echo ok","build":"echo ok"}}
EOF
cat > index.js << 'EOF'
const express = require("express");
const app = express();
app.get("/", (req, res) => res.json({ message: "hello" }));
module.exports = app;
EOF
git add -A && git commit -m "init"

cd ~/forgectl
node dist/index.js run \
  --task "Add a GET /health endpoint" \
  --workflow code \
  --agent codex \
  --repo /tmp/forge-test \
  --dry-run
```
This should print the run plan without executing. Verify it looks correct.

### 8D: Live E2E Test (if Codex auth is available)
```bash
cd ~/forgectl
node dist/index.js run \
  --task "Add a GET /health endpoint that returns { status: 'ok' }" \
  --workflow code \
  --agent codex \
  --repo /tmp/forge-test \
  --no-review \
  --verbose
```

**Success criteria:**
- Agent runs and exits 0
- All validation steps pass
- Output shows `N files changed, +N -N` (NOT 0)
- Branch exists on host: `cd /tmp/forge-test && git log --oneline --all`

If Codex auth is not available, skip this step but note it in the summary.

### 8E: Daemon Test
```bash
cd ~/forgectl
node dist/index.js up --foreground &
DAEMON_PID=$!
sleep 2

# Health check
curl -s http://127.0.0.1:4856/health | jq .

# Auth status
curl -s http://127.0.0.1:4856/auth/status | jq .

# UI serves
curl -s http://127.0.0.1:4856/ | head -3

# Submit a run (will fail without agent, but should accept the request)
curl -s -X POST http://127.0.0.1:4856/runs \
  -H "Content-Type: application/json" \
  -d '{"task":"test","workflow":"code"}' | jq .

# List runs
curl -s http://127.0.0.1:4856/runs | jq .

# Shutdown
kill $DAEMON_PID
wait $DAEMON_PID 2>/dev/null
```

### 8F: Final State Check
```bash
# Everything must be clean
npm run typecheck   # Zero errors
npm test            # All tests pass  
npm run build       # Clean build

# Git status
git status          # Note any uncommitted changes
```

---

## Commit Strategy

Make atomic commits after each sub-phase:
1. After 6A-6G (dashboard): `git add -A && git commit -m "Add Phase 6: web dashboard"`
2. After 7A-7C (polish): `git add -A && git commit -m "Add Phase 7: README, cleanup, polish"`
3. After 8 (verification fixes): `git add -A && git commit -m "Fix issues found in E2E verification"`

Push when done:
```bash
git push origin main
```

Or if on a branch:
```bash
git checkout -b feat/phase-6-7-dashboard-polish
git push -u origin feat/phase-6-7-dashboard-polish
```

---

## Key Files Reference

**Daemon (add UI serving here):**
- `src/daemon/server.ts` — Fastify server, add static file serving
- `src/daemon/routes.ts` — REST API routes, add `/auth/status`

**Events (dashboard consumes these via SSE):**
- `src/logging/events.ts` — RunEvent type and emitter

**Auth (for settings page):**
- `src/auth/claude.ts` — `getClaudeAuth()`
- `src/auth/codex.ts` — `getCodexAuth()`

**Existing working features:**
- `src/cli/run.ts` — `forgectl run` command
- `src/orchestration/single.ts` — Single agent execution
- `src/orchestration/review.ts` — Review mode
- `src/output/git.ts` — Git output collection
- `src/validation/runner.ts` — Validation loop with retry

**Config:**
- `src/config/schema.ts` — Zod schema with defaults
- `.forgectl/config.yaml` — Project config (if exists)

---

## Final Checklist (verify ALL before finishing)

- [ ] Dashboard serves at daemon root URL
- [ ] Dashboard shows runs list from API
- [ ] Dashboard has submit form that works
- [ ] Dashboard has run detail view with log
- [ ] Dashboard has history page
- [ ] Dashboard has settings page with auth status
- [ ] README.md exists and is comprehensive
- [ ] `npm run typecheck` — zero errors
- [ ] `npm test` — all tests pass
- [ ] `npm run build` — clean
- [ ] `forgectl run --dry-run` works
- [ ] `forgectl workflows list` works
- [ ] `forgectl auth list` works
- [ ] Daemon starts and serves API + UI
- [ ] No debug logging, TODOs, or dead code remain
- [ ] All changes committed and pushed
