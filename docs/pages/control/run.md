---
description: "The Run control RPC: its payload, its receipt, and the errors it can answer with."
---

# Control.Run

`Run` is one of the 10 requests in the `ControlRpcs` group. A client reaches it
through `ControlClient` over `/rpc` and `/rpc/ws`, and `smithers serve` hosts it.

## Payload

| Form | Fields |
| --- | --- |
| `Plan` | `planId`, `digest`, `envelope`, `idempotencyKey` |
| `Resume` | `runId`, `idempotencyKey` |

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
| `PlanDigestMismatch` | `plan_digest_mismatch` |
| `EnvelopeMismatch` | `envelope_mismatch` |
| `ClaimLost` | `claim_lost` |
| `LaunchFailed` | `launch_failed` |
| `PersistenceError` | `persistence_failed` |
| `Unavailable` | `unavailable` |

## Source

Generated from `packages/control/src/ControlRpcs.ts`. Run `pnpm docs:pages` after
changing the schema.
