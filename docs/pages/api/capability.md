---
description: "Capability values and permission failures: the leaf vocabulary of the flows permission kernel."
---

# @smthrs/capability

Capability values and permission failures: the leaf vocabulary of the Smithers permission kernel. This package holds only the words, never the enforcement: `@smthrs/kernel` owns the `GrantStore`, the decorating layers, and the journal. Both the kernel and `@smthrs/jj` depend on this leaf, so a protected Host service can name permission failures in its own interface without a `kernel` ↔ `jj` dependency cycle.

```ts
import { Capability, Permission } from "@smthrs/capability"

const rule = new Permission.Rule({
  effect: "allow",
  pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
})
```

:::danger
Schema ids (`@smthrs/capability/Capability`, `@smthrs/capability/PermissionDenied`, and the rest) are digested into step keys and round-trip through the grant journal. Renaming one invalidates recorded runs.
:::

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/capability` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/capability/src/index.ts) | any |
| `@smthrs/capability/Capability` | [src/Capability.ts](https://github.com/smithersai/smithers/blob/main/packages/capability/src/Capability.ts) | any |
| `@smthrs/capability/Permission` | [src/Permission.ts](https://github.com/smithersai/smithers/blob/main/packages/capability/src/Permission.ts) | any |

## Capability

[src/Capability.ts](https://github.com/smithersai/smithers/blob/main/packages/capability/src/Capability.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Action` | type | `fs:read`, `fs:write`, `net:get`, `net:post`, `model:call`, `proc:spawn`, `jj:status`, `jj:diff`, `jj:snapshot`, `jj:restore`, `jj:workspace-add`, `jj:workspace-forget`, `jj:root`, `jj:revert` |
| `Capability` | schema class | `action` plus exact `resource` |
| `CapabilityPattern` | schema class | `action` (or a wildcard `PatternAction`) plus a resource glob |
| `PatternAction` | type | pattern action literals |
| `make` | constructor | builds an exact capability |
| `format`, `formatPattern`, `parse` | functions | the `action:resource` text form |
| `matches` | predicate | pattern against exact capability, whole-resource match |
| `subsumes` | predicate | returns `false` when containment cannot be proven syntactically |
| `EffectTier` | type | `sealed`, `compensable`, `irreversible` |
| `TierOptions` | interface | `workspaceRoot` |
| `tierOf` | function | classifies a capability into a tier |
| `requiresIdempotencyKey` | predicate | true for the irreversible tier |

## Permission

[src/Permission.ts](https://github.com/smithersai/smithers/blob/main/packages/capability/src/Permission.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Rule` | schema class | `effect` plus `pattern` |
| `RuleEffect` | type | `allow`, `deny`, `ask` |
| `evaluate` | function | applies rules to a capability |
| `PermissionRequired`, `PermissionDenied` | classes | typed failures the kernel raises |
| `PermissionError` | type | `PermissionRequired \| PermissionDenied \| GrantStoreError` |
| `permissionRequired`, `permissionDenied` | constructors | |
| `GrantStoreError`, `GrantStoreErrorCode` | class + codes | |
| `isPermissionError` | refinement | narrows `unknown` to a kernel permission failure |
| `formatError` | function | one-line rendering used as the `SystemError` description |
| `toPlatformError` | constructor | projects a permission failure into a `PlatformError` (reason `PermissionDenied`, structured failure on `cause`) |
| `fromPlatformError` | function | recovers the structured failure a `toPlatformError` projection carries |

## The `PlatformError` projection

Effect owns the `FileSystem` and `ChildProcessSpawner` tags, and their error channels are fixed to `PlatformError`. Rather than mint a second tag whose only difference is a wider error type, the kernel decorates those tags in place and maps its failures through `toPlatformError`: the normalized reason is always `PermissionDenied`, `description` carries the `formatError` rendering, and `cause` carries the structured failure itself, so `fromPlatformError` hands an attended surface back the original `capability`, `tier`, `requestId`, and `reason`.
