# smithers CLI

> **Status:** Partial · **Priority:** P0 · **Owner:** smithers-maintainers · **Group:** Run & observe

**What you can do:** Drive every workflow, run, and agent from one command-line tool.

The smithers bin (apps/cli): init, workflow list/run, up, ps, inspect, output, monitor, migrate, gateway, ui, agent management, MCP server. Some read paths have had backend-coupling bugs (sqlite-only reads, camelCase output flags).

## Capabilities

### Run lifecycle

workflow run, up, ps, inspect, output, retry-task, resume.

### Init pack

smithers init seeds workflows, skills, agents, and the durable init system workflow.




## Test cases

- pnpm -C apps/cli test
- pnpm -C e2e test

## Observability

_None recorded yet._

## Debugging

_None recorded yet._

## Architecture

_None recorded yet._

## Fixes & diffs

_None recorded yet._

## Open gaps

- CLI read commands have historically been sqlite-coupled; keep pglite/postgres parity covered by e2e for every read command

