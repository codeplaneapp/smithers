# smithers CLI

> **Status:** Partial | **Priority:** P0 | **Owner:** smithers-maintainers | **Group:** Run & observe

The smithers CLI installs and shares workflow packs, launches and controls runs, inspects durable state, manages worktrees, approvals, schedules, alerts, memory, evals, gateways, UIs, accounts, MCP, migrations, and operational diagnostics.

## What you can do

Operate every workflow lifecycle action from one command-line tool without writing custom driver code.

## Capabilities

### Run lifecycle

`workflow run`, `up`, `ps`, `inspect`, `output`, `retry-task`, `resume`.

### Init pack

`smithers init` seeds workflows, skills, agents, and the durable init system workflow.

### Read-side diagnostics

ps, inspect, logs, events, chat, node, why, tree, diff, output, snapshots, and timeline inspect persisted runs.

### Control actions

approve, deny, ask-human, signal, pause, cancel, down, retry-task, revert, restore, rewind, fork, replay, and timetravel mutate durable state.

### Operational subcommands

gateway, monitor, ui, migrate, eval, optimize, openapi, memory, usage, token, agents, cron, alerts, docs, and upgrade cover the product surface.

### Workflow pack lifecycle

add, remove, eject, share, packs list, and packs update manage local, GitHub, npm, and file-based packs.

### Worktree ownership

worktree list and worktree prune inspect and reclaim worktrees owned by Smithers runs.

### Run narration

status, what, why, node, chat, tree, diff, and timeline turn persisted state into concise operator diagnostics.

## Endpoints and commands

- `CLI smithers up` ([docs](docs/cli/overview.mdx))
- `CLI smithers ps` ([docs](docs/cli/overview.mdx))
- `CLI smithers inspect` ([docs](docs/cli/overview.mdx))
- `CLI smithers why` ([docs](docs/cli/overview.mdx))
- `CLI smithers gateway` ([docs](docs/cli/overview.mdx))
- `CLI smithers add|remove|eject|share|packs` ([docs](docs/reference/packs.mdx))
- `CLI smithers worktree list|prune` ([docs](docs/components/worktree.mdx))

## Related docs

- [CLI catalog](docs/cli/overview.mdx)
- [CLI quickstart](docs/cli/quickstart.mdx)

## Test cases

- `apps/cli/tests/cli.test.js`
- `apps/cli/tests/cli-help.test.js`
- `apps/cli/tests/json-stdout-contract.test.js`
- `apps/cli/tests/watch-mode-read-commands.test.js`
- `apps/cli/tests/sqlite-default-roundtrip.e2e.test.js`
- `apps/cli/tests/pglite-roundtrip.e2e.test.js`
- `apps/cli/tests/postgres-roundtrip.e2e.test.js`
- `apps/cli/tests/docs-cli-overview-coverage.test.js`

## Observability

- CLI read commands can emit json, yaml, md, toon, or jsonl for agents and scripts.
- up can write NDJSON event logs and expose a metrics endpoint when serving.
- why diagnosis summarizes blockers from frames, attempts, approvals, and persisted events.

## Debugging

- Start with `smithers ps`, then `smithers why` <runId>, `smithers inspect` <runId>, `smithers logs` <runId> -f, and `smithers output` <runId> <nodeId>.
- Use --format json and --full-output for machine-readable debugging; use --root to `make launch roots explicit`.

## Architecture

- `apps/cli/src/index.js` registers 80+ commands through incur Cli and delegates to engine, db, server, time-travel, memory, openapi, agents, and observability packages.
- `docs/cli/overview.mdx` is `generated/covered` by tests as the command catalog of record.
- `apps/cli/package.json` declares the CLI as Smithers command-line interface, MCP server, and local workflow tools.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- 2026-07-06 review: `bun test --timeout`=120000 --max-concurrency=1 for the six listed workflow-authoring test files passed.
- 2026-07-18 feature and docs audit: expanded the command inventory for packs, worktree ownership, status, and narration commands.
- `apps/cli/src/index.js`
- `apps/cli/src/*.js`
- `apps/cli/tests/*.test.js`
- `docs/cli/overview.mdx`
- `apps/cli`

## Open gaps

- The CLI surface is broad; keep `pglite/postgres` parity covered for every read and mutation command, not `just launch/read round-trips`.
- Some agent- or browser-dependent commands necessarily skip in CI; document and test their `fake-agent/no-browser` behavior.
