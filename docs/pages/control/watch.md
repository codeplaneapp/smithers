---
description: "The Watch control RPC: its payload, its receipt, and the errors it can answer with."
---

# Control.Watch

`Watch` is one of the 10 requests in the `ControlRpcs` group. A client reaches it
through `ControlClient` over `/rpc` and `/rpc/ws`, and `smithers serve` hosts it.

## Payload

| Field | Type | Required |
| --- | --- | --- |
| `runId` | `string` | no |
| `afterSequence` | `number` | no |
| `follow` | `boolean` | no |

## Success

`declaration`

## Errors

This request has no failure channel.

## Source

Generated from `packages/control/src/ControlRpcs.ts`. Run `pnpm docs:pages` after
changing the schema.
