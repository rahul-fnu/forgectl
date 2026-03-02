# TASK: Debug and fix git output collection — "No changes detected" despite agent making changes

## Problem

`src/output/git.ts` `collectGitOutput()` reports "No changes detected in workspace" even though the agent (Codex) successfully modifies files, creates new files, and all validation passes. The agent's STDOUT confirms it made changes (modified `index.js`, created test files, etc.).

## What We Know From Previous Debugging

1. **The agent DOES make changes.** STDOUT shows files modified/created. Validation (lint/test/build) passes. The agent runs for 30-60 seconds and exits 0.

2. **Previous debug output showed:** `initialSha=, hasAgentCommits=false, hasUnstagedChanges=false` — meaning `git rev-list --max-parents=0 HEAD` returned EMPTY inside the container. This happened because `.git/objects/` was excluded during workspace copy.

3. **We fixed the exclude** — removed `.git/objects/` from the default excludes in `src/config/schema.ts`. After that fix, one run showed: `initialSha=816aa14..., hasAgentCommits=false, hasUnstagedChanges=true` — proving the detection CAN work.

4. **But subsequent runs still show 0 changes.** The fix is in the source, builds are clean, but it's intermittent or there's another issue.

## Your Task

### Step 1: Add comprehensive debug logging

Add temporary debug logging to `src/output/git.ts` in the `collectGitOutput` function. After each git command, log the full stdout and stderr. Specifically:

```typescript
// After git rev-list
logger.info("output", `DEBUG rev-list stdout: "${initialResult.stdout}" stderr: "${initialResult.stderr}" exit: ${initialResult.exitCode}`);

// After git log
logger.info("output", `DEBUG git-log stdout: "${logResult.stdout}" stderr: "${logResult.stderr}" exit: ${logResult.exitCode}`);

// After git add -A  
const addResult = await execInContainer(container, ["git", "add", "-A"], { workingDir: "/workspace" });
logger.info("output", `DEBUG git-add exit: ${addResult.exitCode} stderr: "${addResult.stderr}"`);

// After git diff --cached
logger.info("output", `DEBUG git-diff-cached stdout: "${diffResult.stdout}" stderr: "${diffResult.stderr}" exit: ${diffResult.exitCode}`);

// Also log git status and git log --all for full picture
const statusResult = await execInContainer(container, ["git", "status"], { workingDir: "/workspace" });
logger.info("output", `DEBUG git-status: "${statusResult.stdout}"`);

const fullLogResult = await execInContainer(container, ["git", "log", "--oneline", "--all"], { workingDir: "/workspace" });
logger.info("output", `DEBUG git-log-all: "${fullLogResult.stdout}"`);

// Also check what files exist
const lsResult = await execInContainer(container, ["ls", "-la", "/workspace"], { workingDir: "/workspace" });
logger.info("output", `DEBUG ls-workspace: "${lsResult.stdout}"`);
```

### Step 2: Build and run E2E test

```bash
npm run build

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
  --task "Add a GET /health endpoint that returns { status: 'ok' }" \
  --workflow code \
  --agent codex \
  --repo /tmp/forge-test \
  --no-review \
  --verbose
```

### Step 3: Analyze the debug output

Read ALL the DEBUG lines carefully. They will tell you:
- Whether `.git` history is intact (`rev-list` should return a SHA)
- Whether the agent committed (`git log initial..HEAD` should show commits) or left files uncommitted (`git status` should show modified/untracked files)
- Whether `git add -A` actually stages anything
- What files actually exist in `/workspace`

### Step 4: Fix the root cause

Based on the debug output, fix the issue. Possible causes:

**A) The workspace `.git` directory is still incomplete.** Check if `src/config/schema.ts` still excludes `.git/objects/`. The default excludes should be:
```typescript
exclude: z.array(z.string()).default([
  "node_modules/", "dist/", "build/", "*.log", ".env", ".env.*",
]),
```
Do NOT exclude any `.git` subdirectories.

**B) The agent's changes happen in a different location.** Maybe Codex runs `git init` and creates a new repo, or changes are in a subdirectory.

**C) `execInContainer` workingDir doesn't match the bind mount.** The workspace is bind-mounted at `/workspace` but maybe the container's actual working directory is different.

**D) The rsync/copy excludes more than expected.** Check `src/container/workspace.ts` — the `picomatch` patterns might be matching `.git` subdirectories unexpectedly. Test by adding debug logging to `prepareRepoWorkspace` to see what's being excluded.

**E) The agent's sandbox/approval settings cause it to not write.** But STDOUT says it did write, so this is unlikely.

### Step 5: Remove debug logging and verify

After fixing the root cause:
1. Remove ALL debug logging you added
2. Rebuild: `npm run build`
3. Run the E2E test again
4. Verify output shows `N files changed, +N -N` (not 0)
5. Verify the branch exists on the host: `cd /tmp/forge-test && git log --oneline --all`
6. Run all tests: `npm run typecheck && npm test`

## Key Files

- `src/output/git.ts` — Output collection (the bug is here or in data flowing into it)
- `src/config/schema.ts` — Default excludes (previously had `.git/objects/` which broke things)
- `src/container/workspace.ts` — `prepareRepoWorkspace()` copies repo to temp dir
- `src/container/runner.ts` — `execInContainer()` runs commands in Docker
- `src/orchestration/single.ts` — Orchestration flow that calls collectGitOutput

## Success Criteria

The E2E test must show actual file changes in the output:
```
  Branch: forge/add-a-get-health-endpoint-...
  N files changed, +N -N    ← NOT 0 files changed
```

And the branch must exist on the host repo:
```bash
cd /tmp/forge-test
git log --oneline --all    ← must show the forge/* branch with commits
```
