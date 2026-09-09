# Run the flow in the selected cloud workspace

The app reuses its existing gateway relay. Selecting a Plue workspace binds flow
provisioning, launch and run inspection to that workspace's checkout. Repository
head and local-copy selections keep the existing unbound repository gateway.
This is a routing choice, not an additional coding service or a browser-held
credential. Plue checks repository scope, write permission and workspace
ownership; the first bound-host release requires the actual workspace owner.

## Existing API extensions

The existing Worker `POST /api/workflow/provision` and
`POST /api/workflow/rpc` bodies accept optional `workspaceId` alongside `repo`.
The Worker passes it as `workspace_id` to Plue's existing
`POST /api/repos/{owner}/{repo}/gateway`. Plue returns the same field on a bound
response. A missing or mismatched response binding is refused; it never silently
falls back to a standalone gateway. Canonical nonzero UUIDs are required.

```json
{
  "repo": "owner/repo",
  "workspaceId": "83e75ae5-0920-4000-8000-000000000001",
  "procedure": "Plan",
  "payload": { "flowId": "coding", "input": { "plan": {} } }
}
```

The example illustrates the relay envelope; a real coding plan must satisfy its
flow's schema. Existing requests omitting `workspaceId` retain their prior wire
shape. Gateway credentials stay in the existing per-user Worker Durable Object.
Its existing record key now includes the optional workspace; no new store is
introduced. Legacy records retain their old key.

The gateway's existing `GatewayHealth` and `GatewayConfig` schemas accept optional
`capabilities: string[]`. This schema addition alone does not advertise a coding
host. The configured host must validate its native binding and registered
`Executable.Catalog` before advertising `coding-plan/v1`; Plue refuses an ordinary
CLI as a coding host. Readiness also checks protocol, root hash, version and the
gateway row ID supplied by Plue through `SMITHERS_GATEWAY_ID`.

## Internal state and concurrency

The existing run-trace card gains optional `workspaceId`. New launches and opened
runs capture it before asynchronous work; Plan, approval, Run and provisioning
keep that captured binding even if the user selects another copy while waiting.
The run's subsequent reads, signals, approvals and cancellation derive their
route from that stored run card. A historical card with no binding keeps its
legacy route. UI frame/workspace IDs are unrelated to Plue workspace IDs.

The gateway transport has a private app-level binding resolver, and its existing
methods accept a captured binding when several awaited calls form one operation.
The existing provisioning toast/deduplication identity includes the workspace.
The app uses the same flows, dispatcher and TanStack DB collections; this change
adds no component state or React effects.

## Verification and limits

Tests cover Worker routing, canonical IDs, mismatched responses, missing host
capability, legacy isolation, durable-cache restart, and selection changes during
actual controller provisioning. Run-card tests follow with a later run operation
under another active selection. The bound cloud host still needs to be staged
and deployed for a real end-to-end cloud run; these tests do not claim deployment.
