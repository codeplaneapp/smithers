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

Re-exported from [`@smthrs/capability`](/api/capability), source [packages/capability/src/Capability.ts](https://github.com/smithersai/smithers/blob/main/packages/capability/src/Capability.ts).

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

Re-exported from [`@smthrs/capability`](/api/capability), source [packages/capability/src/Permission.ts](https://github.com/smithersai/smithers/blob/main/packages/capability/src/Permission.ts).

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

## API reference

This page is the public API reference for capability matching, permission decisions, durable grant handling, and permission-decorated host services. It does not provide an operating-system sandbox.

### Policy namespaces

| Namespace | Main public API |
| --- | --- |
| `Capability` | `Capability`, `CapabilityPattern`, `make`, `parse`, `format`, `formatPattern`, `matches`, `subsumes`, `tierOf`, `requiresIdempotencyKey` |
| `CapabilitySet` | `CapabilitySet` value; `fromPatterns`, `none`, `allows`, `intersect`, `equals`, `current`, and `attenuate` |
| `Permission` | `Rule`, `evaluate`, `PermissionRequired`, `PermissionDenied`, `GrantStoreError`, `PermissionError`, `toPlatformError`, `fromPlatformError`, `isPermissionError`, `formatError`, constructor helpers |
| `GrantEvent` | Schema-backed request, resolution, revocation, and envelope grant events |
| `GrantStore` | `GrantStore` service; `make`, `layer`, `makeNoop`, `layerNoop`; pending request and resolution types |
| `JournalGrantStore` | Journal-backed `GrantStore` construction and layer |
| `Workspace` | Workspace-root context used for exact path capabilities |

Rules are ordered and last-match-wins, except an effective configured deny is a hard veto. The default decision is `ask`.

```ts
const readWorkspace = new Permission.Rule({
  effect: "allow",
  pattern: new Capability.CapabilityPattern({
    action: "fs:read",
    resource: "/workspace/**"
  })
})

const decision = Permission.evaluate(
  [[readWorkspace]],
  Capability.make("fs:read", "/workspace/src/main.ts")
)
```

`GrantStore` resolutions are `once`, `run`, `remembered`, and `deny`. Journal persistence is explicit through `JournalGrantStore`; the base `makeNoop` is allow-all and should not be mistaken for a production policy.

### Decorated host namespaces

`FileSystem`, `ChildProcessSpawner`, `Jj`, and `HttpClient` export layers that depend on the corresponding raw platform port plus `GrantStore` and related context. `FileSystem`, `ChildProcessSpawner`, and `HttpClient` decorate Effect's own tags in place: the layer provides the same tag it requires, so there is no second kernel tag. `FileSystem` and `ChildProcessSpawner` project permission failures into `PlatformError` via `Permission.toPlatformError` (reason `PermissionDenied`, structured failure on `cause`, recovered with `Permission.fromPlatformError`); `HttpClient` projects them into `HttpClientError` via `HttpClient.toHttpClientError` (reason `TransportError`, structured failure on `cause`, recovered with `HttpClient.fromHttpClientError`). `Jj` decorates `@smthrs/jj`'s own tag, whose error channel already names the kernel's failures. `Path` explicitly re-exports the pure path-service decision without a permission check.

The `HttpClient` decorator wraps `effect/unstable/http`'s own tag; there is no Smithers transport port beneath it. Every request is checked against `net:get` (GET, HEAD) or `net:post` (everything else) with the lowercased URL host as the resource, or against `model:call` with `host/modelId` when `HttpClient.withModelCall(modelId)` is in scope. Redirects cannot escape the check: platform bundles provide a client that never follows one on its own (fetch with `RequestInit { redirect: "manual" }`, Undici with no redirect interceptor), and the decorator composes Effect's own `HttpClient.followRedirects` *above* the guard, so each hop re-enters the guarded `postprocess` and is authorized independently.

The `ChildProcessSpawner` decorator wraps `effect/unstable/process`'s own tag rather than a Smithers wrapper around it: `spawn` is checked against `proc:spawn` with `CommandLine.render(command)` as the resource, and the derived helpers (`exitCode`, `string`, `lines`, `stream*`) are rebuilt from the guarded `spawn` so none of them can route around the check. Because the guarded implementation replaces Effect's tag, a `Command` run as a plain `Effect` is checked too.

`HostServices` composes the protected layer for the closed host service set. Use it at the application composition boundary:

```text
raw platform port
        ↓
kernel decorator → GrantStore
        ↓
flow-visible service
```

### Process containment

| Namespace | Main public API |
| --- | --- |
| `ContainedSpawner` | `withContainment`, `groupOf`, `defaultGraceMs`, decorator `layer` over Effect's `ChildProcessSpawner` tag |
| `ProcessLedger` | `ProcessLedger` service; `record`, `release`, `reaped`, `live`, `orphans`; `make`, `layer`, `makeMemory`, `layerMemory`, `hostRunId`, `ProcessRecord` |

A cancelled run must leave no process running. `ContainedSpawner.layer` decorates Effect's spawner in place, so it stacks with the permission decorator over one host implementation, and it does two things to every process it starts.

It rewrites the command to carry a kill deadline: `SIGTERM` first, then `SIGKILL` after `graceMs` (default 2000). Without that deadline Effect signals the child once and waits for an exit that a `SIGTERM`-trapping child never reports, so the releasing fiber hangs and the run never reaches `cancelled`. Both legs of a pipeline take the same policy. A command that already names a `killSignal` or a `forceKillAfter` keeps it.

It records the process in `ProcessLedger` and releases the record when the spawn scope closes. Records live in memory and in `Journal` as ownerless durable entries on the run `flows.host:<hostId>`, written under the source id `@smthrs/kernel/ProcessLedger`. Replaying that run gives the next incarnation of the same `hostId` the set of processes an owner it can prove is dead left behind, which is `ProcessLedger.orphans`. `ProcessLedger.layerMemory` runs the same bookkeeping without a journal, so it contains the current incarnation and inherits nothing from a crashed one.

Host facts ride the journal's ownerless channel by design. A process record describes the host rather than a run, every incarnation of a host writes under the same source id, and first-writer-wins is exactly the semantics a spawn record wants; none of these entries is a run decision, so the single-writer-per-run rule is not in play and nothing here fences against a run owner.

The durable half is not best effort. `record`, `release`, `reaped`, and `skipped` all report a write that did not commit, and the spawner refuses a spawn whose record failed: it signals the child and fails the call, because a child no incarnation can discover is the one outcome containment exists to prevent. The one place a ledger failure is logged instead of propagated is the release finalizer, which has nowhere to report it; a missed release leaves the record inherited, and the next reaper finds the pid already gone and retires it then.

The release is announced only after the process has been signalled. The finalizer that retires a record is registered before the spawn, so scope closure runs it after Effect's own kill finalizer: a ledger that announced an exit while the kill was still inside its grace window would be telling the next incarnation to stop looking for something still alive.

The engine needs no hook for any of this. `cancelOwned` interrupts the run fiber, the fiber closes the action scopes, and the scopes own the processes. The ledger and the reaper cover the case a scope cannot: a host killed without running its finalizers.

`@smthrs/platform-node` signals what the ledger reports. `ProcessReaper.reap` kills the abandoned group with `SIGKILL` on POSIX and `taskkill /pid <pid> /T /F` on Windows, and `NodeHost.layerContained` / `BunHost.layerContained` compose the spawner decorator and one reaper sweep into the host layer. `layerContained` also builds `Jj` over the contained spawner (`NodeJj.layerSpawner`), so a `jj` invocation a crashed host left running is a record like any other rather than a process that went around the host.

A stored pid outlives the process that wrote it, so the reaper signals a record only when every one of these holds:

| Guard | Refusal |
| --- | --- |
| The record has a process group of its own. | `no-group` |
| That group is neither this process's pid nor its real process group, read from the operating system. | `own-group` |
| The recorded owner is gone. Only `ESRCH` counts as gone; `EPERM` means another user's live process, and any other answer is a question this host could not ask. | `owner-alive` |
| The record was written during this boot. | `pre-boot` |
| The pid's start time, where the platform can report one, matches the recorded one. | `identity-mismatch` |
| The signal was actually delivered, or the group was already gone. | `kill-failed` |

A kill that succeeded retires the record with `flows.host.process-reaped.v1`. A record refused on identity grounds is retired with `flows.host.process-reap-skipped.v1`, which says in the journal that nothing was signalled. A kill that FAILED retires nothing, so the record stays inherited and the next incarnation tries again; the same is true of `owner-alive`, whose owner will contain its own children.

### Testing

`@smthrs/kernel/test/TestGrantStore` exports `layerAllow`, `layerDeny`, and `layerScripted`. The test module is a public deep import; internal modules are not.

See [Hosts and capabilities](/concepts/hosts-and-capabilities) and the platform bundles that satisfy these ports: [`@smthrs/platform-browser`](/api/platform-browser), `@smthrs/platform-node`, and `@smthrs/platform-bun`.
