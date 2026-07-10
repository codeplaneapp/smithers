# Monitor execution tree shows every node as queued while a run is live

GitHub: https://github.com/smithersai/smithers/issues/817

Open `smithers monitor` on a running run: the Execution tree renders every node
as **queued** even when the engine has dozens of nodes finished and in flight.
Observed on ticket-fleet run `run-1783713026863` (75 finished / 16 in-progress
per `smithers claude tick`) — the monitor tree showed 100% queued, which reads
as a wedged or cancelled run.

## Root cause

The tree is built from `getDevToolsSnapshot`, whose `DevToolsSnapshotNode.task`
carries only `{nodeId, kind, label, iteration}` — no lifecycle state. The client
mapper (`packages/gateway-client/src/sync/snapshotToGatewayRunNode.ts`,
`nodeStatus()`) therefore leaves every non-root, non-blocked node `queued` until
the run finishes.

The per-node lifecycle already exists: `smithers claude tick` derives real
`pending / in-progress / finished / failed` states for the same run from the
workspace DB.

## Fix

- `getDevToolsSnapshot` attaches each task node's lifecycle state server-side
  from the same source `claude tick` uses (DB-derived, so it also works for
  detached runs the gateway process does not own).
- `snapshotToGatewayRunNode` prefers `task.state` when present; keep current
  fallbacks for older gateways.
- Regenerate `packages/gateway/openapi.yaml` and update
  `docs/rpc/get-dev-tools-snapshot.mdx` for the added field.
- Real-backend test: launch a run with a fake agent and assert the snapshot's
  node states change across frames (no mocks).

> Closed: fixed on main in 5740af8e43.
