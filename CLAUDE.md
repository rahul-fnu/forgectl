# CLAUDE.md — forgectl

## Project Overview
forgectl is a CLI + daemon that runs AI agents (Claude Code, Codex) inside isolated Docker containers for any workflow (code, research, content, data, ops). Users bring their own AI subscriptions (BYOK). forgectl provides the sandbox, validation, orchestration, and output collection.

## Tech Stack
- **Language:** TypeScript, targeting Node.js 20+
- **CLI framework:** commander
- **Config:** js-yaml (YAML parsing) + zod (runtime validation)
- **Docker:** dockerode (Docker Engine API client for Node.js)
- **HTTP server:** fastify (for daemon REST API)
- **Agent messaging:** agent-relay (npm dependency, MIT licensed)
- **Terminal output:** chalk
- **Globs:** picomatch
- **Credential storage:** keytar (cross-platform keychain)
- **Testing:** vitest
- **Build/bundle:** tsup
- **Linting:** eslint (flat config) + prettier

## Project Structure
```
src/
├── index.ts              # CLI entry point (commander setup)
├── cli/                  # CLI command handlers
├── workflow/             # Workflow system (types, registry, resolver, built-in definitions)
├── config/               # Config schema (zod), YAML loader, defaults
├── auth/                 # BYOK credential management (keychain, Claude, Codex)
├── container/            # Docker sandbox (build, run, exec, network, workspace, secrets, cleanup)
├── agent/                # Agent adapters (Claude Code, Codex, interface)
├── orchestration/        # Multi-agent (single, review, parallel, Agent Relay integration)
├── validation/           # Validation retry loop (run checks, feed errors back to agent)
├── output/               # Output collection (git branch or files directory)
├── context/              # Context Engine v2 (builder, prompt, learning, Merkle-aware budget assembly)
├── kg/                   # Knowledge Graph with Merkle tree (parser, graph, storage, builder, query, merkle, conventions, test-mapping, git-history, flaky-tests)
├── task/                 # Task specification (types, schema, loader, validator, scaffold)
├── planner/              # Planner agent (planner, validator)
├── analysis/             # Outcome analyzer (pattern detection, self-improvement task generation)
├── logging/              # Logger, terminal UI, JSON run logs, SSE events
├── ui/                   # Web dashboard (React + Vite, served by daemon)
└── utils/                # Template expansion, slugs, timers, hashing, duration parsing
```

## Key Architecture Decisions
1. **Workflows are profiles, not pipelines.** A workflow configures the sandbox (image, network, tools, validation, output mode). The agent decides how to do the task.
2. **Two output modes:** `git` (branch with commits for code/ops) and `files` (directory for research/content/data).
3. **Validation is universal.** Same mechanism for all workflows: run command → check exit code → feed errors to agent → retry. What changes is the commands.
4. **Agent invocations are individual CLI calls.** `claude -p "..."` each time. No persistent sessions.
5. **Validation retries restart ALL steps** from the top after each agent fix.
6. **Merge priority:** CLI flags > project config > workflow definition > global defaults.
7. **Network is open by default.** Containers use standard Docker bridge networking. Optionally restricted via `allowlist` mode (iptables) or `airgapped` mode (`--network=none`).
8. **Knowledge Graph uses Merkle trees.** Content hashing enables incremental invalidation — only reparse files whose content hash changed. Per-workspace KG builds support stacked diffs.
9. **Convention extraction is data-driven.** Patterns are mined from the codebase (naming, testing, error handling) and injected into agent context automatically.
10. **Context Engine is budget-aware.** Merkle tree nodes carry size metadata; assembly respects a token budget with compression tiers (full → signatures-only → names-only).

## Commands
```bash
npm run build         # Compile TypeScript
npm run dev           # Watch mode
npm test              # Run vitest
npm run lint          # ESLint
npm run typecheck     # tsc --noEmit
```

## Testing
- Unit tests: `test/unit/` — config, templates, workflow resolver, prompt builder, validation logic
- Integration tests: `test/integration/` — Docker operations (need Docker running)
- E2E tests: `test/e2e/` — full run with real containers
- Skip Docker tests: `FORGECTL_SKIP_DOCKER=true npm test`

## Multi-Repo Support
- Per-issue repo routing: issue description contains `**Repo:** https://github.com/owner/name`
- Repo profiles at `~/.forgectl/repos/<name>.yaml` override workspace hooks, validation, and PR target
- The orchestrator auto-detects the repo from the issue and loads the matching profile
- Merge daemon polls all repos from profiles directory

## Review/Merge Daemon (integrated into orchestrator)
- Review daemon posts structured review comments on PRs (MUST_FIX/SHOULD_FIX/NIT)
- Self-addressing loop: when review requests changes, Claude auto-fixes on the branch (max 3 rounds)
- SHA tracking prevents re-reviewing unchanged code
- Only MUST_FIX blocks merge; SHOULD_FIX and NIT are posted as feedback
- Merge daemon auto-merges after review approval
- GitHub App token auto-refresh prevents expiry on long runs

## Next: Reactive Maintenance
- See `docs/REACTIVE-MAINTENANCE-PLAN.md` for upcoming features
- CI failure dispatch, post-merge test generation, triage gate, reproduce-first prompting

## Conventions
- Use `async/await` everywhere (no callbacks)
- All Docker operations go through `dockerode`, never shell out to `docker` CLI
- Errors: throw typed errors with context, catch at CLI boundary
- Logging: use the structured logger (`src/logging/logger.ts`), not console.log
- Config values: always validate with zod before use
- Template variables: `{{var}}` syntax, expanded via `src/utils/template.ts`
- File paths: always use `path.join()`, never string concatenation
