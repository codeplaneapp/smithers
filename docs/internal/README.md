# Smithers documentation

This documentation covers the Smithers durable-execution library: its implemented Effect APIs, durability model, host boundaries, and known gaps. Its scope is limited to the packages in this workspace.

## Reading order

For a first pass, read:

1. [Durable execution model](../pages/concepts/durable-execution-model.md)
2. [Flows and the action graph](../pages/concepts/action-graph.md)
3. [Determinism and replay](../pages/concepts/determinism-and-replay.md)
4. [Journal](../pages/concepts/journal.md)
5. [Step keys and content addressing](../pages/concepts/step-keys.md)
6. [Getting started](../pages/guides/getting-started.md)
7. [Writing a flow](../pages/guides/writing-a-flow.md)

Read [implementation status](../pages/release/support-matrix.md) before choosing a deployment architecture. It distinguishes working library surfaces from planned integration work. Three sections there answer the questions that come up first:

- [Not in release 1](../pages/release/support-matrix.md#not-in-release-1) — subsystems that exist in this tree and are not part of release 1: `@smthrs/triggers`, `@smthrs/evals`, `@smthrs/gateway`, memory semantic recall, and OTLP export.
- [Abandoned runs and supervision](../pages/release/support-matrix.md#abandoned-runs-and-supervision) — abandoned runs are **not** auto-resumed in this release, and the manual resume path.
- [Substrate pin and known upstream issues](../pages/release/support-matrix.md#substrate-pin-and-known-upstream-issues) — the exact `effect@4.0.0-rc.108` pin and the upstream defects tracked against it.

Private-alpha operators should also read the [alpha notes](../alpha-notes.md) for current operational limits.

## Concepts

- [Durable execution model](../pages/concepts/durable-execution-model.md) — executions, actions, suspension, ownership, and recovery.
- [Flows and the action graph](../pages/concepts/action-graph.md) — dependency structure and the current limit of Bazel-like planning.
- [Determinism and replay](../pages/concepts/determinism-and-replay.md) — replay-safe flow bodies and recorded effect boundaries.
- [Journal](../pages/concepts/journal.md) — the logical WAL, its durable and lossy channels, durable order, projections, and run state.
- [Step keys and content addressing](../pages/concepts/step-keys.md) — canonical serialization, cache keys, and invocation keys.
- [Effect integration and error taxonomy](../pages/concepts/effect-integration.md) — services, layers, schemas, and the three effect tiers.
- [Failure and retry policy](../pages/concepts/failure-and-retry.md) — typed failures, retry policy, and interruption.
- [Concurrency](../pages/concepts/concurrency.md) — fibers, durable races, queues, and run coordination.
- [Host adapters and capability enforcement](../pages/concepts/hosts-and-capabilities.md) — the closed Host surface and permission-decorated layers.
- [Time travel](../pages/concepts/time-travel.md) — frames, replay, fork, rewind, compensation, and recovery.
- [Sync](../pages/concepts/sync.md) — read-only journal catch-up and following over Effect RPC.
- [Subflows](../pages/concepts/subflows.md) — current attached-child behavior and unsupported detached children.

## Guides

- [Getting started](../pages/guides/getting-started.md)
- [Writing a flow](../pages/guides/writing-a-flow.md)
- [Using the durable engine](../pages/guides/durable-engine.md)
- [Testing](../pages/guides/testing.md)
- [Control-plane trust posture](../pages/guides/control-plane-trust.md) — bearer authentication, loopback binding, and alpha authorization limits.
- [Migrating from Smithers 0.x](../pages/migration/1.0.md) — what changes, the three commands, and what the migration refuses to do.

## Package reference

- [Build-system local repositories](build/local-repositories.md) — opaque nested workspaces, explicit input boundaries, and `S.Repo.Target`
- [`@smthrs/flows`](../pages/api/flows.md) — barrel package re-exporting everything below
- [`@smthrs/database`](../pages/api/database.md)
- [`@smthrs/jj`](../pages/api/jj.mdx)
- [`@smthrs/sandbox`](../pages/api/sandbox.md)
- [`@smthrs/platform-browser`](../pages/api/platform-browser.md)
- `@smthrs/platform-node` and `@smthrs/platform-bun` — the Node and Bun Host bundles; see the [platform-node](../pages/api/platform-node.md) and [platform-bun](../pages/api/platform-bun.md) API pages
- [`@smthrs/journal`](../pages/api/journal.md)
- [`@smthrs/run-store`](../pages/api/run-store.md)
- [`@smthrs/step-cache`](../pages/api/step-cache.md)
- [`@smthrs/artifacts`](../pages/api/artifacts.md)
- [`@smthrs/registry`](../pages/api/registry.md)
- [`@smthrs/agent`](../pages/api/agent.md)
- [`@smthrs/capability`](../pages/api/capability.md)
- [`@smthrs/kernel`](../pages/api/kernel.md)
- [`@smthrs/canonical`](../pages/api/canonical.md)
- [`@smthrs/crypto`](../pages/api/crypto.md)
- [`@smthrs/keys`](../pages/api/keys.md)
- [`@smthrs/plan`](../pages/api/plan.md)
- [`@smthrs/flow`](../pages/api/flow.md)
- [`@smthrs/engine`](../pages/api/engine.md)
- [`@smthrs/engine-store`](../pages/api/engine-store.md)
- [`@smthrs/sync`](../pages/api/sync.md)
- [`@smthrs/time-travel`](../pages/api/time-travel.md)
- [`@smthrs/memory`](../pages/api/memory.md)
- [Trellis and DelegationChain](../pages/api/patterns-delegation.md), the delegation patterns in `@smthrs/patterns`
- [`@smthrs/control`](../pages/api/control.md)
- [`@smthrs/notifications`](../pages/api/notifications.md)
- [`@smthrs/migrate`](../pages/migration/migrate-tool.md), which upgrades a Smithers 0.x project to this authoring model

Vendor host adapters (`@smthrs/host-cloudflare`, `@smthrs/host-vercel`) are
documented in the [plugins repository](https://github.com/smithersai/plugins).

## Architecture

- [Package map](../pages/architecture/package-map.md)
- [Browser support](../pages/architecture/browser-support.md) — which entry points bundle for a browser, which are Node-only, and the gate that proves it.
- [Execution and data flow](../pages/architecture/execution-data-flow.md)
- [Design decisions](../pages/design-decisions.md)
- [Implementation status](../pages/release/support-matrix.md)
- [Alpha notes](../alpha-notes.md) — known limitations for the private alpha, including the register of test pins.

## Releasing

- [Release runbook](release-runbook.md) — what a human runs to publish the engine train.

## Documentation conventions

“Implemented” means the behavior exists in `packages/*/src` and is exercised by the repository’s package tests. “Planned” means the source contains only a contract, test double, TODO, or no API at all. Examples use the repository’s current `effect@4.0.0-rc.108` APIs and the public `@smthrs/*` package exports.
