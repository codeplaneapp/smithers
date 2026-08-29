# Smithers Flows documentation

This documentation covers the `flows` durable-execution library: its implemented Effect APIs, durability model, host boundaries, and known gaps. Its scope is limited to the packages in this workspace.

## Reading order

For a first pass, read:

1. [Durable execution model](concepts/durable-execution-model.md)
2. [Flows and the action graph](concepts/action-graph.md)
3. [Determinism and replay](concepts/determinism-and-replay.md)
4. [Journal](concepts/journal.md)
5. [Step keys and content addressing](concepts/step-keys.md)
6. [Getting started](guides/getting-started.md)
7. [Writing a flow](guides/writing-a-flow.md)

Read [implementation status](architecture/implementation-status.md) before choosing a deployment architecture. It distinguishes working library surfaces from planned integration work. Three sections there answer the questions that come up first:

- [Not in release 1](architecture/implementation-status.md#not-in-release-1) — subsystems that exist in this tree and are not part of release 1: `@smthrs/triggers`, `@smthrs/evals`, `@smthrs/gateway`, memory semantic recall, and OTLP export.
- [Abandoned runs and supervision](architecture/implementation-status.md#abandoned-runs-and-supervision) — abandoned runs are **not** auto-resumed in this release, and the manual resume path.
- [Substrate pin and known upstream issues](architecture/implementation-status.md#substrate-pin-and-known-upstream-issues) — the exact `effect@4.0.0-rc.108` pin and the upstream defects tracked against it.

Private-alpha operators should also read the [alpha notes](alpha-notes.md) for current operational limits.

## Concepts

- [Durable execution model](concepts/durable-execution-model.md) — executions, actions, suspension, ownership, and recovery.
- [Flows and the action graph](concepts/action-graph.md) — dependency structure and the current limit of Bazel-like planning.
- [Determinism and replay](concepts/determinism-and-replay.md) — replay-safe flow bodies and recorded effect boundaries.
- [Journal](concepts/journal.md) — the logical WAL, its durable and lossy channels, durable order, projections, and run state.
- [Step keys and content addressing](concepts/step-keys.md) — canonical serialization, cache keys, and invocation keys.
- [Effect integration and error taxonomy](concepts/effect-integration.md) — services, layers, schemas, and the three effect tiers.
- [Failure and retry policy](concepts/failure-and-retry.md) — typed failures, infrastructure interruption, and tier-aware retry.
- [Concurrency](concepts/concurrency.md) — fibers, durable races, queues, and run coordination.
- [Host adapters and capability enforcement](concepts/hosts-and-capabilities.md) — the closed Host surface and permission-decorated layers.
- [Time travel](concepts/time-travel.md) — frames, replay, fork, rewind, compensation, and recovery.
- [Sync](concepts/sync.md) — read-only journal catch-up and following over Effect RPC.
- [Subflows](concepts/subflows.md) — current attached-child behavior and unsupported detached children.

## Guides

- [Getting started](guides/getting-started.md)
- [Writing a flow](guides/writing-a-flow.md)
- [Using the durable engine](guides/durable-engine.md)
- [Testing](guides/testing.md)
- [Control-plane trust posture](guides/control-plane-trust.md) — bearer authentication, loopback binding, and alpha authorization limits.

## Package reference

- [Package-mode local repositories](reference/local-repositories.md) — opaque nested workspaces, explicit input boundaries, and `S.Repo.Target`
- [`@smthrs/flows`](reference/flows.md) — barrel package re-exporting everything below
- [`@smthrs/database`](reference/database.md)
- [`@smthrs/jj`](reference/jj.md)
- [`@smthrs/sandbox`](reference/sandbox.md)
- [`@smthrs/platform-browser`](reference/platform-browser.md)
- `@smthrs/platform-node` and `@smthrs/platform-bun` — the Node and Bun Host bundles; see the [platform-node](pages/api/platform-node.md) and [platform-bun](pages/api/platform-bun.md) API pages
- [`@smthrs/journal`](reference/journal.md)
- [`@smthrs/run-store`](reference/run-store.md)
- [`@smthrs/step-cache`](reference/step-cache.md)
- [`@smthrs/artifacts`](reference/artifacts.md)
- [`@smthrs/capability`](reference/capability.md)
- [`@smthrs/kernel`](reference/kernel.md)
- [`@smthrs/canonical`](reference/canonical.md)
- [`@smthrs/crypto`](reference/crypto.md)
- [`@smthrs/keys`](reference/keys.md)
- [`@smthrs/plan`](reference/plan.md)
- [`@smthrs/flow`](reference/flow.md)
- [`@smthrs/engine`](reference/engine.md)
- [`@smthrs/engine-store`](reference/engine-store.md)
- [`@smthrs/sync`](reference/sync.md)
- [`@smthrs/time-travel`](reference/time-travel.md)

Vendor host adapters (`@smthrs/host-cloudflare`, `@smthrs/host-vercel`) are
documented in the [plugins repository](https://github.com/smithersai/plugins).

## Architecture

- [Package map](architecture/package-map.md)
- [Browser support](architecture/browser-support.md) — which entry points bundle for a browser, which are Node-only, and the gate that proves it.
- [Execution and data flow](architecture/execution-data-flow.md)
- [Design decisions](architecture/design-decisions.md)
- [Implementation status](architecture/implementation-status.md)
- [Alpha notes](alpha-notes.md) — known limitations for the private alpha, including the register of test pins.

## Releasing

- [Release runbook](release-runbook.md) — what a human runs to publish the engine train.
- [Release rehearsal receipt](release-rehearsal.md) — the recorded no-publish rehearsal of that path.

## Documentation conventions

“Implemented” means the behavior exists in `packages/*/src` and is exercised by the repository’s package tests. “Planned” means the source contains only a contract, test double, TODO, or no API at all. Examples use the repository’s current `effect@4.0.0-rc.108` APIs and the public `@smthrs/*` package exports.
