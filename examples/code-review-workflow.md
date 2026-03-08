---
# Example WORKFLOW.md for forgectl orchestrator
# This file configures a code review workflow that watches GitHub Issues,
# dispatches AI agents to implement changes, and validates results.
#
# Place this file at .forgectl/workflows/code-review.md in your project,
# or reference it via the `workflow` field in your forgectl config.

tracker:
  kind: github
  token: $GITHUB_TOKEN
  repo: owner/repo
  labels: [forgectl]
  active_states: [open]
  terminal_states: [closed]
  auto_close: true
  done_label: done
  in_progress_label: in-progress

polling:
  interval_ms: 30000

concurrency:
  max_agents: 2

workspace:
  root: ~/.forgectl/workspaces
  hooks:
    after_create: "git clone https://github.com/owner/repo.git ."
    before_run: "git checkout main && git pull"

agent:
  type: claude-code
  model: sonnet
  timeout: 30m

validation:
  steps:
    - name: typecheck
      command: npm run typecheck
      retries: 2
    - name: test
      command: npm test
      retries: 3
    - name: lint
      command: npm run lint
      retries: 1
  on_failure: abandon
---
You are a code review assistant. Implement the changes requested in this issue.

## Issue: {{issue.title}}

{{issue.description}}

## Instructions
- Work in the /workspace directory
- Make targeted changes to address the issue
- Ensure all existing tests still pass
- Follow the project's coding conventions
- Commit your changes with a descriptive message

{{#if attempt}}
This is retry attempt {{attempt}}. Review previous feedback and fix any remaining issues.
{{/if}}
