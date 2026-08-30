---
description: "The Signal control RPC: its payload, its receipt, and the errors it can answer with."
---

# Control.Signal

`Signal` is one of the 10 requests in the `ControlRpcs` group. A client reaches it
through `ControlClient` over `/rpc` and `/rpc/ws`, and `smithers serve` hosts it.

## Payload

| Field | Type | Required |
| --- | --- | --- |
| `runId` | `string` | yes |
| `signal` | `{ name, payload }` | yes |
| `idempotencyKey` | `string` | yes |

## Success

| Receipt | Fields |
| --- | --- |
| `Accepted` | `receiptId`, `runId` |
| `AlreadyApplied` | `receiptId`, `runId` |
| `Parked` | `receiptId`, `planId`, `status` |
| `Conflict` | `message` |
| `Terminal` | `runId`, `status` |

## Errors

| Error | Code |
| --- | --- |
| `RunNotFound` | `run_not_found` |
| `PersistenceError` | `persistence_failed` |
| `Unavailable` | `unavailable` |

## Source

Generated from `packages/control/src/ControlRpcs.ts`. Run `pnpm docs:pages` after
changing the schema.
