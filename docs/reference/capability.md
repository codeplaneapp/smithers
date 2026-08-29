# `@smthrs/capability`

This page is the public API reference for the capability vocabulary: capability values, wildcard patterns, effect tiers, policy rules, and the typed permission failures a guarded Host call can add. Enforcement — the `GrantStore`, the decorating layers, the journal — lives in [`@smthrs/kernel`](kernel.md).

The package is a leaf: it depends on `effect` alone, so both `@smthrs/kernel` and `@smthrs/jj` can depend on it without a cycle, and a protected service names permission failures in its own interface. Schema ids (`@smthrs/capability/Capability`, `@smthrs/capability/PermissionDenied`, …) are digested into step keys and round-trip through the grant journal, so renaming one invalidates recorded runs.

## Namespaces

| Namespace | Main public API |
| --- | --- |
| `Capability` | `Capability`, `CapabilityPattern`, `Action`, `PatternAction`, `make`, `parse`, `format`, `formatPattern`, `matches`, `subsumes`, `EffectTier`, `TierOptions`, `tierOf`, `requiresIdempotencyKey` |
| `Permission` | `Rule`, `RuleEffect`, `evaluate`, `PermissionRequired`, `PermissionDenied`, `GrantStoreError`, `GrantStoreErrorCode`, the `PermissionError` union, `permissionRequired`, `permissionDenied`, `isPermissionError`, `formatError`, `toPlatformError`, `fromPlatformError` |

```ts
import { Capability, Permission } from "@smthrs/capability"

const decision = Permission.evaluate(
  [[
    new Permission.Rule({
      effect: "allow",
      pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
    })
  ]],
  Capability.make("fs:read", "/workspace/src/main.ts")
)
```

## Actions and tiers

`Action` is the closed vocabulary: `fs:read`, `fs:write`, `net:get`,
`net:post`, `model:call`, `proc:spawn`, and the jj slot's `jj:status`,
`jj:diff`, `jj:snapshot`, `jj:restore`, `jj:workspace-add`,
`jj:workspace-forget`, `jj:root`, and `jj:revert`. Actions are durable
identity: never repurpose one, add one.

`tierOf` classifies a capability. Reads are `sealed` (`fs:read`, `net:get`,
`model:call`, `jj:status`, `jj:diff`, `jj:root`). Undoable writes are
`compensable` (`jj:snapshot`, `jj:restore`, `jj:workspace-add`,
`jj:workspace-forget`, `jj:revert`, and an `fs:write` inside the workspace
root). The rest are `irreversible` (`net:post`, `proc:spawn`, and an
`fs:write` that escapes the workspace), and only those require an idempotency
key to retry.

## The `PlatformError` projection

Where Effect owns a decorated tag (`FileSystem`, `ChildProcessSpawner`) the error channel is fixed to `PlatformError`, so the kernel maps its failures through `Permission.toPlatformError`: reason `PermissionDenied`, `description` from `Permission.formatError`, and the structured `PermissionError` on `cause`. `Permission.fromPlatformError` recovers it, so an attended surface can still reply to a `PermissionRequired` request and an unattended report can still name the capability.

See the [kernel reference](kernel.md) for the decorating layers and grant handling.
