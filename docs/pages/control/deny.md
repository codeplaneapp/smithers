---
description: "The Deny control RPC: its payload, its receipt, and the errors it can answer with."
---

# Control.Deny

`Deny` is one of the 10 requests in the `ControlRpcs` group. A client reaches it
through `ControlClient` over `/rpc` and `/rpc/ws`, and `smithers serve` hosts it.

## Payload

| Field | Type | Required |
| --- | --- | --- |
| `target` | `Plan \| Node` | yes |
| `scope` | `"once" \| "run" \| "remembered"` | yes |
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
| `PlanDigestMismatch` | `plan_digest_mismatch` |
| `EnvelopeMismatch` | `envelope_mismatch` |
| `AlreadyResolved` | `already_resolved` |
| `PlanNotFound` | `plan_not_found` |
| `RunNotFound` | `run_not_found` |
| `InvalidInput` | `invalid_input` |
| `PersistenceError` | `persistence_failed` |
| `Unavailable` | `unavailable` |

## Source

Generated from `packages/control/src/ControlRpcs.ts`. Run `pnpm docs:pages` after
changing the schema.
