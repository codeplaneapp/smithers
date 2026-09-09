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

The existing run-trace, run-list, approval, and approvals-inbox cards carry
optional `workspaceId`. New launches and opened
runs capture it before asynchronous work; Plan, approval, Run and provisioning
keep that captured binding even if the user selects another copy while waiting.
The run's subsequent reads, signals, approvals and cancellation derive their
route from recorded card provenance, including a run first seen in a list or
approval inbox. Conflicting stored bindings refuse instead of guessing. Approval
submissions use the trusted persisted approval binding. Older ancillary cards
that omitted a binding may inherit it only from the run’s already-recorded bound
run-trace card. Current selection never repairs historical ownership; explicit
disagreements still refuse and identify the conflicting card. An unbound run-trace
keeps its legacy route unless another recorded card explicitly names a workspace;
that disagreement refuses and names both bindings rather than redirecting the run. A historical card with no binding keeps its
legacy route. UI frame/workspace IDs are unrelated to Plue workspace IDs.

The gateway transport has a private app-level binding resolver, and its existing
methods accept a captured binding when several awaited calls form one operation.
The existing provisioning toast/deduplication identity includes the workspace.
The app uses the same flows, dispatcher and TanStack DB collections; this change
adds no component state or React effects.

Bound list/inbox card IDs include their workspace so another listing does not
replace the first workspace's evidence. The existing `runs.list` flow accepts
optional `sourceCard`, used by its filter buttons to retain that card's binding
when the active selection changes; the controller validates kind and repository.
The same argument works through slash and agent doors:

```text
/runs.list parked sourceCard=run-list-owner/repo-83e75ae5-0920-4000-8000-000000000001 owner/repo
```

The shared `@smthrs/rpc/GatewayWorkspace` module exposes the small validation
contract used by both persisted cards and the Worker (new exported helpers):

```ts
import { GatewayWorkspaceIdSchema, isGatewayWorkspaceId } from "@smthrs/rpc/GatewayWorkspace"
const id = GatewayWorkspaceIdSchema.parse("ffffffff-ffff-ffff-ffff-ffffffffffff")
isGatewayWorkspaceId(id) // true: canonical hex, not restricted to an RFC version nibble
```

This aligns with Plue's existing canonical lowercase, non-nil ID predicate. The
Worker keeps its prior `isGatewayWorkspaceId` export as a re-export.

## Verification and limits

Tests cover Worker routing, canonical IDs, mismatched responses, missing host
capability, legacy isolation, durable-cache restart, and selection changes during
actual controller provisioning. Run-card tests follow with a later run operation
under another active selection. The bound cloud host still needs to be staged
and deployed for a real end-to-end cloud run; these tests do not claim deployment.
