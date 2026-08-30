---
description: "The control RPCs smithers serve hosts, and the gateway projections a UI subscribes to."
---

# Control plane

The control plane is the boundary between a caller and a run. `@smthrs/control`
declares the requests, `ControlServer` hosts them, `ControlClient` calls them, and
[`smithers serve`](/cli/serve) mounts both over HTTP and WebSocket. Every CLI
command and every UI reaches a run through this surface, never through the run
store or the journal tables.

## Requests

| Request | Payload | Answer |
| --- | --- | --- |
| [`Approve`](/control/approve) | `target`, `scope`, `idempotencyKey` | `Accepted \| AlreadyApplied \| Parked \| Conflict \| Terminal` |
| [`Cancel`](/control/cancel) | `runId`, `idempotencyKey`, `reason` | `Accepted \| AlreadyApplied \| Parked \| Conflict \| Terminal` |
| [`Deny`](/control/deny) | `target`, `scope`, `idempotencyKey` | `Accepted \| AlreadyApplied \| Parked \| Conflict \| Terminal` |
| [`List`](/control/list) | `flows \| runs` | `flows \| runs` |
| [`Plan`](/control/plan) | `flowId`, `input`, `idempotencyKey` | `{ planId, flowId, digest, inputSummary, envelope, deployClass, plan, nodes, approval }` |
| [`Resume`](/control/resume) | `runId`, `idempotencyKey` | `Accepted \| AlreadyApplied \| Parked \| Conflict \| Terminal` |
| [`Run`](/control/run) | `Plan \| Resume` | `Accepted \| AlreadyApplied \| Parked \| Conflict \| Terminal` |
| [`Signal`](/control/signal) | `runId`, `signal`, `idempotencyKey` | `Accepted \| AlreadyApplied \| Parked \| Conflict \| Terminal` |
| [`Steer`](/control/steer) | `runId`, `message`, `idempotencyKey` | `Accepted \| AlreadyApplied \| Parked \| Conflict \| Terminal` |
| [`Watch`](/control/watch) | `runId`, `afterSequence`, `follow` | `declaration` |

## Projections

`smithers serve` streams these read models over `/projections/ws`. A projection is
a derived view of the journal: subscribing to one never claims a run and never
writes.

| Projection | Subscribed over |
| --- | --- |
| `workspace-runs` | `/projections/ws` |
| `run-summary` | `/projections/ws` |
| `run-events` | `/projections/ws` |
| `transcript` | `/projections/ws` |
| `run-tree` | `/projections/ws` |
| `plan-cards` | `/projections/ws` |
| `approvals` | `/projections/ws` |
| `node-output` | `/projections/ws` |

## Transports

| Path | Carries |
| --- | --- |
| `/rpc` | one control request per HTTP call |
| `/rpc/ws` | the same requests plus `Watch`, which streams |
| `/sync` and `/sync/ws` | read-only journal replication for followers |
| `/projections/ws` | the projections above |
| `/health` | `GatewayHealth`: workspace hash, gateway id, protocol version |

## Source

Generated from `packages/control/src/ControlRpcs.ts` and
`packages/gateway/src/GatewaySchema.ts`. Run `pnpm docs:pages` after changing
either.
