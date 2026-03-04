# TASK: E2E Test forgectl Pipelines — Debug and Fix Until Working

You are testing the new pipeline orchestration feature in forgectl. Your job is to run real pipelines end-to-end, find what's broken, fix it, and verify it works. Do NOT stop until you have a pipeline that actually executes multiple nodes with real agent output.

**Read SPEC.md for context on how pipelines work.**

---

## Step 1: Verify the Build

```bash
cd ~/forgectl
npm run build
npm run typecheck
FORGECTL_SKIP_DOCKER=true npm test
```

All 211+ tests must pass. If any fail, fix them first.

---

## Step 2: Test Pipeline CLI Commands

### 2A: Show a pipeline DAG

```bash
node dist/index.js pipeline show --file examples/auth-system.yaml
```

Expected: terminal rendering of the DAG with nodes and edges. If it errors, debug and fix.

### 2B: Dry-run a pipeline

```bash
node dist/index.js pipeline run --file examples/auth-system.yaml --dry-run
```

Expected: shows execution plan without running anything. If it errors, debug and fix.

### 2C: Cycle detection

```bash
cat > /tmp/bad-pipeline.yaml << 'EOF'
name: bad-pipeline
nodes:
  - id: a
    task: "do A"
    depends_on: [b]
  - id: b
    task: "do B"
    depends_on: [a]
EOF

node dist/index.js pipeline show --file /tmp/bad-pipeline.yaml
```

Expected: error message about cycle detected. If it doesn't detect the cycle, fix the DAG validation.

### 2D: Missing dependency detection

```bash
cat > /tmp/bad-deps.yaml << 'EOF'
name: bad-deps
nodes:
  - id: a
    task: "do A"
    depends_on: [nonexistent]
EOF

node dist/index.js pipeline show --file /tmp/bad-deps.yaml
```

Expected: error about missing dependency. Fix if needed.

---

## Step 3: Create a Simple Test Pipeline

Create a minimal 2-node linear pipeline that actually works:

```bash
# Set up test repo
rm -rf /tmp/forge-pipeline-test
mkdir /tmp/forge-pipeline-test && cd /tmp/forge-pipeline-test
git init
cat > package.json << 'EOF'
{
  "name": "pipeline-test",
  "scripts": {
    "lint": "echo ok",
    "typecheck": "echo ok",
    "test": "echo ok",
    "build": "echo ok"
  }
}
EOF
cat > index.js << 'EOF'
const express = require("express");
const app = express();
app.get("/", (req, res) => res.json({ message: "hello" }));
module.exports = app;
EOF
git add -A && git commit -m "init"
```

Create the pipeline:

```bash
cd ~/forgectl
cat > /tmp/simple-pipeline.yaml << 'EOF'
name: simple-test
description: Two-step pipeline to verify chaining works
defaults:
  workflow: code
  agent: codex
  repo: /tmp/forge-pipeline-test

nodes:
  - id: add-health
    task: "Add a GET /health endpoint that returns { status: 'ok' }. Do not modify existing endpoints."

  - id: add-version
    task: "Add a GET /version endpoint that returns { version: '1.0.0' }. Do not modify existing endpoints or the /health endpoint."
    depends_on: [add-health]
EOF
```

### 3A: Show the pipeline

```bash
node dist/index.js pipeline show --file /tmp/simple-pipeline.yaml
```

### 3B: Dry-run the pipeline

```bash
node dist/index.js pipeline run --file /tmp/simple-pipeline.yaml --dry-run
```

### 3C: Execute the pipeline for real

```bash
node dist/index.js pipeline run --file /tmp/simple-pipeline.yaml --verbose
```

**This is the critical test.** Watch for:

1. Node `add-health` starts and runs Codex in a Docker container
2. Node `add-health` completes with file changes
3. Node `add-version` starts AFTER `add-health` completes
4. Node `add-version` sees the health endpoint (it should be on the branch from step 1)
5. Node `add-version` completes with additional file changes
6. Pipeline shows "completed" with both nodes successful

**If it fails at any point, debug:**
- Read the error message carefully
- Check if it's a pipeline executor issue, an agent invocation issue, or an output collection issue
- Add debug logging if needed
- Fix the issue
- Re-run the pipeline

**Common issues to watch for:**
- The executor might not pass the repo path correctly to the run engine
- Branch piping might not work (node 2 doesn't start from node 1's branch)
- The pipeline might not resolve CLIOptions correctly from node + defaults
- The executor might not handle the single-node execution interface correctly
- Docker/auth issues (these should work since v1 E2E passed)

### 3D: Verify the output

After successful pipeline execution:

```bash
cd /tmp/forge-pipeline-test
git log --oneline --all
git branch -a
```

Expected: Two forge branches, one from each node. The second branch should contain BOTH the health endpoint and the version endpoint.

```bash
# Check the final branch has both endpoints
LATEST_BRANCH=$(git branch -a | grep forge | tail -1 | tr -d ' ')
git diff main...$LATEST_BRANCH
```

---

## Step 4: Test Parallel Pipeline

Create a fan-out pipeline where two nodes run in parallel:

```bash
rm -rf /tmp/forge-parallel-test
mkdir /tmp/forge-parallel-test && cd /tmp/forge-parallel-test
git init
cat > package.json << 'EOF'
{
  "name": "parallel-test",
  "scripts": {
    "lint": "echo ok",
    "typecheck": "echo ok",
    "test": "echo ok",
    "build": "echo ok"
  }
}
EOF
cat > index.js << 'EOF'
const express = require("express");
const app = express();
app.get("/", (req, res) => res.json({ message: "hello" }));
module.exports = app;
EOF
git add -A && git commit -m "init"

cd ~/forgectl
cat > /tmp/parallel-pipeline.yaml << 'EOF'
name: parallel-test
description: Test parallel node execution
defaults:
  workflow: code
  agent: codex
  repo: /tmp/forge-parallel-test

nodes:
  - id: add-health
    task: "Add a GET /health endpoint that returns { status: 'ok' }."

  - id: add-version
    task: "Add a GET /version endpoint that returns { version: '1.0.0' }."

  - id: add-readme
    task: "Create a README.md documenting the API endpoints: /, /health, and /version."
    depends_on: [add-health, add-version]
EOF
```

### 4A: Show the DAG

```bash
node dist/index.js pipeline show --file /tmp/parallel-pipeline.yaml
```

Expected: `add-health` and `add-version` at the same level, `add-readme` below depending on both.

### 4B: Execute

```bash
node dist/index.js pipeline run --file /tmp/parallel-pipeline.yaml --verbose
```

Watch for:
- `add-health` and `add-version` should start at roughly the same time (parallel)
- `add-readme` should wait for BOTH to complete
- The branch merge for `add-readme` should succeed (health and version modify different parts)
- All three nodes should complete successfully

**If the merge fails**, debug:
- Check what branches were created
- Try the merge manually: `git merge branch1 branch2`
- Fix the merge logic in `src/pipeline/merge.ts`

### 4C: Verify output

```bash
cd /tmp/forge-parallel-test
git log --oneline --all
git branch -a
# The final branch should have health endpoint + version endpoint + README
```

---

## Step 5: Test Checkpointing

If the parallel pipeline worked:

### 5A: Check if checkpoints were saved

```bash
ls -la ~/forgectl/.forgectl/checkpoints/ 2>/dev/null || echo "No checkpoints dir"
find ~/forgectl/.forgectl/checkpoints -name "*.json" 2>/dev/null
```

### 5B: Test rerun

```bash
# Rerun from add-readme (should skip add-health and add-version)
node dist/index.js pipeline rerun --file /tmp/parallel-pipeline.yaml --from add-readme --verbose
```

Expected: `add-health` and `add-version` are skipped (using checkpoints), only `add-readme` re-executes.

### 5C: Test pipeline status

```bash
node dist/index.js pipeline status --file /tmp/parallel-pipeline.yaml
```

---

## Step 6: Test Daemon Pipeline API

```bash
cd ~/forgectl
node dist/index.js up --foreground &
sleep 2

# List pipelines
curl -s http://127.0.0.1:4856/pipelines | python3 -m json.tool

# Submit a pipeline via API (use the simple pipeline)
PIPELINE_JSON=$(python3 -c "
import yaml, json, sys
with open('/tmp/simple-pipeline.yaml') as f:
    data = yaml.safe_load(f)
print(json.dumps({'pipeline': data}))
")
curl -s -X POST http://127.0.0.1:4856/pipelines \
  -H "Content-Type: application/json" \
  -d "$PIPELINE_JSON" | python3 -m json.tool

# Check dashboard
curl -s http://127.0.0.1:4856/ | head -5

node dist/index.js down
```

---

## Step 7: Fix and Iterate

If ANY of the above tests failed:

1. Identify the root cause from error messages and logs
2. Fix the code
3. Run `npm run build && npm run typecheck && FORGECTL_SKIP_DOCKER=true npm test`
4. Re-run the failing test
5. Repeat until it passes

**Do not stop until:**
- The simple 2-node linear pipeline executes successfully end-to-end
- Both nodes produce actual file changes
- The second node builds on the first node's output
- All unit tests still pass

---

## Step 8: Final Verification

```bash
cd ~/forgectl
npm run typecheck
FORGECTL_SKIP_DOCKER=true npm test
npm run build

# v1 still works
node dist/index.js run --task "test" --workflow code --agent codex --repo /tmp/forge-pipeline-test --dry-run

# Pipeline commands work
node dist/index.js pipeline show --file examples/auth-system.yaml
node dist/index.js pipeline run --file /tmp/simple-pipeline.yaml --dry-run

git add -A
git diff --cached --stat
git commit -m "Fix pipeline E2E issues found during testing"
git push origin main
```

---

## Success Criteria

You are DONE when ALL of these are true:

- [ ] `npm run typecheck` — zero errors
- [ ] `npm test` — all tests pass
- [ ] `forgectl pipeline show` renders a DAG in the terminal
- [ ] `forgectl pipeline run --dry-run` shows execution plan
- [ ] Cycle detection works (rejects cyclic pipelines)
- [ ] A real 2-node linear pipeline executes E2E with Codex producing actual changes
- [ ] The second node builds on the first node's branch output
- [ ] `forgectl run` (v1 single task) still works
- [ ] All changes committed and pushed
