---
description: "The List control RPC: its payload, its receipt, and the errors it can answer with."
---

# Control.List

`List` is one of the 10 requests in the `ControlRpcs` group. A client reaches it
through `ControlClient` over `/rpc` and `/rpc/ws`, and `smithers serve` hosts it.

## Payload

| Form | Fields |
| --- | --- |
| `flows` | `filters`, `cursor`, `limit` |
| `runs` | `filters`, `cursor`, `limit` |

## Success

| Receipt | Fields |
| --- | --- |
| `flows` | `items`, `nextCursor` |
| `runs` | `items`, `nextCursor` |

## Errors

| Error | Code |
| --- | --- |
| `RunNotFound` | `run_not_found` |
| `FlowNotFound` | `flow_not_found` |
| `PlanDigestMismatch` | `plan_digest_mismatch` |
| `EnvelopeMismatch` | `envelope_mismatch` |
| `ClaimLost` | `claim_lost` |
| `AlreadyResolved` | `already_resolved` |
| `InvalidInput` | `invalid_input` |
| `Unauthorized` | `unauthorized` |
| `Unavailable` | `unavailable` |
| `TransportError` | `transport_error` |
| `PersistenceError` | `persistence_failed` |
| `LaunchFailed` | `launch_failed` |
| `NoMatchingWait` | `no_matching_wait` |

## Source

Generated from `packages/control/src/ControlRpcs.ts`. Run `pnpm docs:pages` after
changing the schema.
