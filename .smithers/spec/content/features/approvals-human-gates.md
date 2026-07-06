# Approvals, human tasks, and durable waits

> **Status:** Partial | **Priority:** P0 | **Owner:** smithers-maintainers | **Group:** Approve & steer

Smithers supports approval gates, typed Approval decision nodes, HumanTask requests, ask-human CLI/MCP waits, signals, timers, denial policies, and resume from waiting states.

## What you can do

Pause risky steps for a human decision, collect structured answers, resume later, and keep the wait visible to agents and operators.

## Capabilities

### Approval gates

Task needsApproval pauses before execution; approve/deny resolves the gate and resume continues the run.

### Typed approval nodes

<Approval> emits a decision row that downstream workflow rendering can branch on.

### HumanTask and ask-human

Richer human requests collect structured JSON through CLI and MCP surfaces with timeout handling.

### External waits

Signal, WaitForEvent, and Timer persist waits so foreground and detached owners can exit cleanly.

## Endpoints and commands

- `CLI smithers approve` ([docs](docs/cli/overview.mdx))
- `CLI smithers deny` ([docs](docs/cli/overview.mdx))
- `CLI smithers ask-human` ([docs](docs/cli/overview.mdx))
- `RPC submitApproval` ([docs](docs/rpc/submit-approval.mdx))
- `RPC submitSignal` ([docs](docs/rpc/submit-signal.mdx))

## Related docs

- [Approval component](docs/components/approval.mdx)
- [Human task](docs/components/human-task.mdx)
- [Signal](docs/components/signal.mdx)

## Test cases

- `packages/engine/tests/approval-component.test.jsx`
- `packages/engine/tests/approval-extended.test.jsx`
- `packages/engine/tests/approval-observability.test.jsx`
- `packages/engine/tests/human-requests.test.js`
- `packages/engine/tests/human-task-prompt.test.jsx`
- `apps/cli/tests/approval-command.test.js`
- `apps/cli/tests/ask-human.e2e.test.js`
- `apps/cli/tests/ask-human-mcp.test.js`
- `e2e/faults/case03-restart-waiting-approval.test.ts`
- `e2e/faults/case04-restart-waiting-event.test.ts`
- `e2e/faults/case05-restart-waiting-timer.test.ts`

## Observability

- Approval request/decision rows are exposed through listApprovals, workflow UIs, CLI ps/why/inspect, and approval metrics.
- e2e faults verify waits survive owner restart for approvals, external events, and timers.

## Debugging

- Run `smithers ps` --status waiting-approval, `smithers why` <runId>, then `smithers approve` or deny <runId> before resuming.
- Use listApprovals/submitApproval RPC when debugging UI-side decision flows.

## Architecture

- `packages/engine/src/approvals.js` and `packages/engine/src/human-requests.js` own durable request rows and resolution semantics.
- `docs/how-it-works.mdx` documents needsApproval, Approval, HumanTask, and denial policies.
- `apps/cli/src/index.js` exposes approve, deny, ask-human, human, and signal commands.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- 2026-07-06 adversarial review: downgraded from fixed to partial because only part of the cited approval proof was observed passing.
- `packages/engine/src/approvals.js`
- `packages/engine/src/human-requests.js`
- `packages/components/src/components/Approval.js`
- `apps/cli/src/ask-human.js`
- `apps/cli/tests/approval-command.test.js`

## Open gaps

- 2026-07-06 review: the targeted approval proof failed `e2e/faults/case03-restart-waiting-approval.test.ts` with Timed out waiting for resumed run to finish, so durable waiting-approval restart is not proven.
