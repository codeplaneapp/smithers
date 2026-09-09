# Planning and repair model authority

The private `evidenceOnly` composition restricts `coding/review-request`,
`coding/draft-plan`, `coding/select-owner-repair`, `coding/draft-poc`,
`coding/review-poc`, and `wiki/review-page` at
their executing action boundary. Apply it to those model action layers above
the deployment's existing shared `Action.Implementations` and `FlowRuntime`.
It does not create a service, database, or public authoring API.

Both direct action execution and calls from an interpreted plan narrow the
existing `AgentAction.Host` capability envelope to empty and intersect the
ambient `CapabilitySet` with empty authority. The inherited registry, flow
bindings, and child runners are removed for those model calls. This runs after
the native module host restores parent authority, including on resume; a
construction-time host override alone would be overwritten.

The model receives the action's gathered evidence and existing system/plugin
prompt context. Plugin and telemetry hooks remain installed. A plugin may
contribute another declaration, but its tool dispatch still has zero tool
capabilities. The restriction includes reads, writes, and process execution;
a prompt asking the model to avoid tools is not the enforcement mechanism.

Budget accounting, seat resolution, quota handling, steering, event delivery,
and schema correction retain their existing services and error behavior.
Implementation actions keep the parent's granted capabilities. Narrowing is
scoped to the listed action handlers and cannot widen their parent authority.
