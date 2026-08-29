---
description: "The Plan control RPC: its payload, its receipt, and the errors it can answer with."
---

# Control.Plan

`Plan` is one of the 10 requests in the `ControlRpcs` group. A client reaches it
through `ControlClient` over `/rpc` and `/rpc/ws`, and `smithers serve` hosts it.

## Payload

| Field | Type | Required |
| --- | --- | --- |
| `flowId` | `string` | yes |
| `input` | `JSON value` | yes |
| `idempotencyKey` | `string` | no |

## Success

| Field | Type | Required |
| --- | --- | --- |
| `planId` | `string` | yes |
| `flowId` | `string` | yes |
| `digest` | `string` | yes |
| `inputSummary` | `string` | yes |
| `envelope` | `{ capabilities, flows, budget, host }` | yes |
| `deployClass` | `boolean` | yes |
| `plan` | `object` | no |
| `nodes` | `array` | yes |
| `approval` | `{ target, scope, idempotencyKey }` | yes |

## Errors

| Error | Code |
| --- | --- |
| `FlowNotFound` | `flow_not_found` |
| `InvalidInput` | `invalid_input` |
| `PersistenceError` | `persistence_failed` |
| `Unavailable` | `unavailable` |

## Source

Generated from `packages/control/src/ControlRpcs.ts`. Run `pnpm docs:pages` after
changing the schema.
