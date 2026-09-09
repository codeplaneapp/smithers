# Configured coding host

`host.ts` is this repository's private deployment recipe. It composes the existing native Control host, executable catalog, `AgentAction`, QuickJS sandbox, Plue JJ adapter and immutable command checks. It is not a public coding service, database, gateway extension or second executor.

The same Effect composition runs on Node and Bun. The concrete adapters supply filesystem, path, subprocess containment, crypto, SQLite, model transport and HTTP. No Node sidecar is required on Bun. Runtime-specific imports stay at the executable boundary; repository workflows do not select a runtime.

The `coding/implement` role must map to an explicit `provider:model` through the existing `SeatResolver`. Workspace/user provider configuration supplies authentication. The host neither invents provider defaults nor copies platform seat credentials into the workspace process. Its deployment entry requires `SMITHERS_CODING_IMPLEMENT_MODEL` and the owning `SMITHERS_GATEWAY_ID`; the existing `SMITHERS_API_KEY` authenticates the gateway. These are operator configuration, never fields accepted from a plan.

The executable accepts the existing command shape:

```sh
smithers serve --root /home/developer/workspace --host 0.0.0.0 --port 7331 --listen
```

`--help` and `--version` work before opening the repository or resolving provider credentials. The same `Serve.refuse` policy requires a credential and explicit `--listen` for a non-loopback bind. The Plue service owns its workspace lifetime lock and process scope.

`coding-plan/v1` is advertised only after the configured catalog includes `coding` and `coding/implementation` with their expected native delegates, and Plue's adapter verifies the repository's provisioned native binding. Conflicted JJ state refuses startup. The gateway reports the existing protocol version and workspace hash, plus the owning gateway row ID. The ordinary CLI does not advertise this capability.

Catalog imports need the existing trusted host filesystem to load verified declaration bytes through a temporary sibling module. That filesystem is scoped to startup loading. Resulting handler registrations use the original guarded context. Immutable checks separately capture the trusted filesystem only for host-owned scratch creation and cleanup; their processes retain the contained, guarded spawner. Agent file tools retain their workspace guards.

Every native handler traverses recorded parent edges to its one active, approved Control root. It receives the existing `AgentAction.Host` with that root's approved capability envelope, along with the shared budget and quota policy. Construction-time services grant no execution authority. The real standard tool catalog is shared with `AgentSession`.

Steering uses `Notifications.make` over the captured Control notification queue. It is addressed to the approved root, including after a cold descendant resume. Drain boundaries combine the native execution ID with the agent's frame boundary, so two descendants cannot accidentally replay each other's drain. Native usage and execution evidence remain in the native journal; Control lifecycle and steering remain in their existing stores.

The host catalog is pinned for its process lifetime. Deploying a changed executable definition requires restarting the host. A source change after approval explicitly fails the old plan; restarting cannot make that old approval describe the new source. An ordinary host without the configured catalog leaves native module runs parked.

The native acceptance fixture uses a scripted model behind the existing `SeatResolver`, while exercising the actual `AgentAction`, QuickJS cell, guarded write, Plue adapter, immutable checks and durable Control/engine journals. This distinguishes executable evidence from an agent's claimed summary. Both required fast and slow checks must inspect the implemented revision before validation succeeds.
