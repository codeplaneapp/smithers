---
description: "Capability enforcement at the host boundary: grant checks decorated onto each host service tag in place."
---

# @smthrs/kernel

Capability enforcement at the host boundary. The kernel decorates each host service tag in place, as a middleware `Layer` over the very tag the platform adapter provides, checking a capability against a grant store before delegating. There is no second, "protected" tag: where Effect owns the tag (`FileSystem`, `ChildProcessSpawner`) a denied request surfaces as a `PlatformError` whose reason is `PermissionDenied` and whose `cause` carries the structured kernel failure (`Permission.fromPlatformError` reads it back); `HttpClient` is the same story in Effect's network channel, projecting a denial into an `HttpClientError` whose reason is a `TransportError` (`HttpClient.fromHttpClientError` reads it back); where Smithers owns the service (`Jj`) the interface names the kernel's failures directly. The `Capability` and `Permission` namespaces are re-exports from `@smthrs/capability`.

```ts
import { Capability, Permission } from "@smthrs/kernel"

const rule = new Permission.Rule({
  effect: "allow",
  pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
})
```

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/kernel` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/index.ts) | any |
| `@smthrs/kernel/test/TestGrantStore` | [src/test/TestGrantStore.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/test/TestGrantStore.ts) | any |

## Capability

Re-exported from [`@smthrs/capability`](capability.md), source [packages/capability/src/Capability.ts](https://github.com/smithersai/smithers/blob/main/packages/capability/src/Capability.ts).

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

## CapabilitySet

[src/CapabilitySet.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/CapabilitySet.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `CapabilitySet` | interface | the ambient authority envelope |
| `fromPatterns`, `none` | constructors | |
| `allows` | predicate | |
| `intersect`, `attenuate` | functions | authority can only narrow |
| `equals` | predicate | |
| `current` | effect | reads the ambient set |

## Permission

Re-exported from [`@smthrs/capability`](capability.md), source [packages/capability/src/Permission.ts](https://github.com/smithersai/smithers/blob/main/packages/capability/src/Permission.ts).

| Export | Kind | Notes |
| --- | --- | --- |
| `Rule` | schema class | `effect` plus `pattern` |
| `RuleEffect` | type | `allow`, `deny`, `ask` |
| `evaluate` | function | applies rules to a capability |
| `PermissionRequired`, `PermissionDenied` | classes | typed failures the kernel raises |
| `PermissionError` | type | `PermissionRequired \| PermissionDenied \| GrantStoreError`, the channel `Jj` exposes directly |
| `permissionRequired`, `permissionDenied` | constructors | |
| `GrantStoreError`, `GrantStoreErrorCode` | class + codes | |
| `isPermissionError` | refinement | narrows `unknown` to a kernel permission failure |
| `formatError` | function | one-line rendering used as the `SystemError` description |
| `toPlatformError` | constructor | projects a permission failure into a `PlatformError` (reason `PermissionDenied`, structured failure on `cause`) for Effect-owned tags |
| `fromPlatformError` | function | recovers the structured failure a `toPlatformError` projection carries |

## GrantStore and GrantEvent

| Export | Source | Notes |
| --- | --- | --- |
| `GrantStore.GrantStore`, `Service`, `make`, `layer`, `makeNoop`, `layerNoop` | [src/GrantStore.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/GrantStore.ts) | `makeNoop` is an explicit allow-all seam |
| `GrantStore.PendingRequest`, `Resolution`, `EnvelopeGrantOptions`, `MakeOptions`, `Persist` | same | request and resolution shapes |
| `GrantStore.isValidGrantPattern`, `isValidEnvelopePattern` | same | pattern admission |
| `GrantEvent.OnceGrant`, `RunGrant`, `RememberedGrant`, `DeniedGrant`, `EnvelopeGrant` | [src/GrantEvent.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/GrantEvent.ts) | durable decision schemas |
| `GrantEvent.GrantEventSchema`, `GrantEvent`, `GrantTier`, `GrantScope`, `decode`, `encode` | same | |
| `JournalGrantStore.make`, `layer`, `JournalGrantStoreOptions` | [src/JournalGrantStore.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/JournalGrantStore.ts) | persists decisions as `flows.kernel.grant.*` journal events |
| `TestGrantStore.layerAllow`, `layerDeny`, `layerScripted` | [src/test/TestGrantStore.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/test/TestGrantStore.ts) | scripted behavior for suites |

## Decorated host services

Each module below exports a `layer` that decorates the matching service tag in place. `FileSystem`, `ChildProcessSpawner`, and `HttpClient` decorate Effect's own tags (permission failures projected into `PlatformError` and `HttpClientError` respectively); `Jj` decorates `@smthrs/jj`'s tag and re-exports it. No module declares a kernel-owned service tag.

| Module | Source | Guarded actions |
| --- | --- | --- |
| `FileSystem` | [src/FileSystem.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/FileSystem.ts) | `fs:read`, `fs:write`; also exports `canonicalResource` |
| `ChildProcessSpawner` | [src/ChildProcessSpawner.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/ChildProcessSpawner.ts) | `proc:spawn`, whose resource is `CommandLine.render(command)`; re-exports Effect's tag, `make`, plus `makeNoop`/`layerNoop` stubs |
| `Jj` | [src/Jj.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/Jj.ts) | the six `jj:*` actions; re-exports `@smthrs/jj`'s tag, `make`, `makeNoop`, and `layerNoop` |
| `HttpClient` | [src/HttpClient.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/HttpClient.ts) | `net:get`, `net:post`, and `model:call` under `withModelCall`; re-exports Effect's tag and `make`, plus `toHttpClientError`/`fromHttpClientError`, the `ModelCall` reference, and `makeNoop`/`layerNoop` stubs. Redirects are followed *above* the guard with Effect's `followRedirects`, so every hop is rechecked |
| `Path` | [src/Path.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/Path.ts) | none; pure path manipulation is not checked |
| `Workspace` | [src/Workspace.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/Workspace.ts) | supplies the root used to resolve path capabilities |

## HostServices

[src/HostServices.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/HostServices.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `HostService`, `HostServiceTags`, `HostServiceIds` | type + consts | the one closed list of Host tags; the kernel decorates each in place, so there is no second "protected" list |
| `layer` | layer | decorates every service in the list, composed over a raw host bundle with `Layer.provide` |

## What the kernel does not do

:::warning
The kernel is a capability check at the adapter call site. It does not sandbox the operating system, and it does not observe reads or writes that bypass the decorated services. Hermetic execution additionally needs a `StepBoundary` implementation.
:::
