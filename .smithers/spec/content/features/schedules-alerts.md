# Schedules and durable alerts

> **Status:** Partial | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Run & observe

Create, list, delete, and manually run cron schedules for workflows, and persist operator-managed alert instances with typed policy metadata, severity, dedupe, silence, acknowledgement, and resolution state.

## What you can do

Run workflows on durable schedules and give operators persistent alert state without hiding the current boundary between policy metadata and notification automation.

## Capabilities

### Cron lifecycle

CLI and Gateway RPC create, list, delete, and manually run schedule rows with overlap-safe execution.

### Durable alert instances

Alerts support firing, acknowledged, silenced, and resolved states with recurrence and operator attribution.

### Typed alert policy

Workflow options carry defaults, rules, labels, runbooks, severity, and emit, pause, cancel, approval, or delivery reaction metadata.

## Endpoints and commands

- `CLI smithers cron` ([docs](docs/cli/overview.mdx))
- `CLI smithers alerts` ([docs](docs/guides/alerting.mdx))
- `RPC cronList|cronCreate|cronDelete|cronRun` ([docs](docs/rpc/cron-list.mdx))

## Related docs

- [Alerting](docs/guides/alerting.mdx)
- [Cron RPC](docs/rpc/cron-create.mdx)

## Test cases

- `apps/cli/tests/cron-command-scheduler.test.js`
- `packages/db/tests/alert-instances.test.js`
- `e2e/faults/case18-cron-manual-overlap.test.ts`
- `e2e/faults/case29-soak-cron-2h-no-stuck.test.ts`

## Observability

- Cron rows record schedule, input, enabled state, next run time, and manual execution state through CLI and Gateway RPC.
- Durable alert rows retain severity, fingerprint, occurrence count, owner, runbook, reaction metadata, and acknowledgement or resolution state.

## Debugging

- Use `smithers cron list` and cron run to distinguish schedule calculation from workflow launch failures.
- Use `smithers alerts list` --format json to inspect firing, acknowledged, silenced, and resolved state.

## Architecture

- `apps/cli` and `packages/server` expose cron scheduling through CLI, Gateway RPC, and server tick paths.
- `packages/db` stores cron and alert instances; workflow alertPolicy remains declarative metadata consumed by runtime integrations.

## Fixes and diffs

- 2026-07-18 feature and docs audit: added cron schedules and durable alert instances as a first-class operator feature; focused cron and alert suites passed 17 tests, while the policy-gated real-overlap case remained skipped in this environment.
- `apps/cli`
- `packages/db`
- `packages/server`
- `packages/gateway`
- `docs/guides/alerting.mdx`
- `docs/rpc/cron-list.mdx`

## Open gaps

- Alert policy is stored and an AlertRuntime wrapper exists, but core does not yet evaluate rules, poll approval age, deliver notifications, or execute pause, cancel, and approval reactions automatically.
