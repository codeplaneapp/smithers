# Herdr supervision, steer, and hijack

> **Status:** Partial | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Recover & replay

Mirror a run into a herdr terminal workspace and supervise it beside your coding agent: a pane per agent node, a cockpit outline, one-key steer, live hijack, first-class reasoning effort, and `approve/deny` auto-resume. Fully degradable.

## What you can do

Watch and steer long-running agent workflows from the same terminal as the agent driving them, without leaving the CLI.

## Capabilities

### Herdr workspace mirroring

Mirror any run into a Herdr workspace with `smithers up` --herdr or smithers herdr attach.

### Portable workflow supervisor

Inspect live workflow state with smithers supervisor and its top alias.

### Durable steer queue

Queue an instruction against a running node with smithers steer.

### Live session handoff

Hand off a live agent session with `smithers hijack` and resume the workflow afterward.

### In-pane approvals

Answer approval gates with `smithers approve` --watch and auto-resume parked detached runs.

## Endpoints and commands

- `CLI smithers herdr` ([docs](docs/integrations/herdr.mdx))

## Related docs

- [herdr integration](docs/integrations/herdr.mdx)
- [workflow supervisor](docs/guide/workflow-supervisor.mdx)
- [watch and steer](docs/guide/watch-and-steer.mdx)

## Test cases

- `packages/herdr/tests/createHerdrRunSurface.test.js`
- `packages/herdr/tests/cockpitPolicy.test.js`
- `apps/cli/tests/herdr-cli.e2e.test.js`
- `apps/cli/tests/herdr-full-loop.e2e.test.js`
- `apps/cli/tests/smithers-top.test.js`
- `apps/cli/tests/steer-command.e2e.test.js`
- `apps/cli/tests/tail-steer-keys.test.js`
- `apps/cli/tests/approve-watch.e2e.test.js`

## Observability

- SteerQueued / SteerConsumed / SteerExpired events carry runId, nodeId, steerId, and `attempt/iteration` attribution.
- RunHijackRequested / RunHijacked mark the park-and-hand-off transition; attempt effort is queryable on \_smithers\_attempts.effort.

## Debugging

- smithers herdr status reports server version, protocol, and client compatibility; a missing server makes --herdr a silent no-op.
- `smithers inspect` <runId> lists `queued/consumed/expired` steers; `smithers why` <runId> shows steers alongside blockers.

## Architecture

- `packages/herdr` owns the herdr client and HerdrRunSurface; it renders and relays only — Smithers keeps execution, isolation, and durability.
- `apps/cli/src/herdr.js` mirrors runs into `workspaces/panes`; smithers-top.js is the portable workflow supervisor (gateway-sourced by default, --direct for local store).
- `packages/engine/src/steers.js` queues and expires steers; the engine consumes them at the next generate() boundary.

## Fixes and diffs

- 2026-07-26 initial record: herdr supervision, steer, hijack, first-class effort, and `approve/deny` auto-resume shipped in 0.32.0.
- `packages/herdr/src/HerdrRunSurface.ts`
- `apps/cli/src/herdr.js`
- `apps/cli/src/smithers-top.js`
- `apps/cli/src/steer.js`
- `packages/engine/src/steers.js`

## Open gaps

- Mid-turn steer injection (landing an instruction between an agent's tool calls) is deferred; steers apply at the next generate() boundary.
