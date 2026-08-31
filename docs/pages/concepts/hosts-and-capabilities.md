---
description: "The closed host surface, the permission kernel that decorates it, and the transaction that captures a hermetic boundary."
---

# Hosts and capabilities

This page describes the portable host surface and the permission kernel that mediates side effects. It covers engine-facing filesystem, process, network, and workspace operations, not higher-level application policy.

## The closed host surface

`@smthrs/kernel` owns the closed list, `HostServiceTags` and `HostServiceIds`, of these protected services:

- Effect `FileSystem`
- Effect `Path`
- Effect `ChildProcessSpawner`
- `Jj` (contract in [`@smthrs/jj`](/api/jj))
- Effect `HttpClient`

Four of the five slots hold Effect's own tags. Smithers used to define a `Shell` service in the third slot; it was `effect/unstable/process` with fewer features, so it was deleted and the slot now holds `effect/process/ChildProcessSpawner` (see [design decisions](/design-decisions)). The fifth slot went the same way: a Smithers-defined one-hop `HttpTransport` was deleted in favour of `effect/HttpClient`. Smithers supplies implementations of both, Node, Bun, an in-browser one, and a remote one, and adds only the capability check.

The list is closed, not the package: `Jj` ships as its own package so a consumer that only needs that capability does not take the whole host surface. The contract stays in `@smthrs/jj`; the kernel decorates that same tag (and re-exports it for convenience) rather than declaring a second one, and the composite bundles (`NodeHost`, `BunHost`, `BrowserHost`, `TestHost`) provide all five tags. There is no pseudo-terminal service: interactive-terminal support is out of core by design (see [design decisions](/design-decisions)).

Clock and Random are tracked as host built-ins. This workspace ships Node,
Bun, browser, and deterministic test layers for the same service tags.
Cloudflare and Vercel adapters live in the separate
[plugins repository](https://github.com/smithersai/plugins). Unsupported
operations fail through their service contract; they should not disappear
from the environment type.

Host bundles provide an `HttpClient` that never follows a redirect on its own: the fetch layers are configured with `RequestInit { redirect: "manual" }`, and Undici installs no redirect interceptor. Redirect following belongs *above* the kernel's guard: the decorator composes Effect's own `HttpClient.followRedirects` over the checked client, so every network hop is authorized independently.

## Kernel decoration

The kernel decorates each service tag in place, a middleware `Layer` over the very tag the platform adapter provides, so there is no second "protected" tag to reach around. Each decorator:

1. derives an exact `Capability`,
2. asks `GrantStore` to authorize it,
3. calls the raw platform port only when allowed.

Where Effect owns the tag (`FileSystem`, `ChildProcessSpawner`) the error channel stays `PlatformError`: a refused operation surfaces with reason `PermissionDenied`, and the structured kernel failure rides on its `cause`, recoverable with `Permission.fromPlatformError`. `HttpClient` does the same in Effect's network channel: a refusal is an `HttpClientError` whose reason is a `TransportError` carrying the kernel failure on `cause`, recoverable with `HttpClient.fromHttpClientError`. Where Smithers owns the service (`Jj`) the interface names `Permission.PermissionError` directly.

The `Jj` slot carries two optional operations, `root` and `revert`, checked as `jj:root` (sealed) and `jj:revert` (compensable). The decorator forwards their absence: a backend that cannot revert keeps reading as one, because a caller deciding what it can offer needs "this host has no revert" and not "your revert was refused".

For a spawn, the exact capability is `proc:spawn` with `CommandLine.render(command)` as its resource: the same string a browser interpreter or a remote sandbox is handed for supported commands, so a grant and the thing it authorizes cannot drift apart. A custom shell path is included explicitly in the resource; adapters that cannot select it reject the command.

```ts
import { Capability, Permission } from "@smthrs/kernel"

const rule = new Permission.Rule({
  effect: "allow",
  pattern: new Capability.CapabilityPattern({
    action: "fs:read",
    resource: "/workspace/**"
  })
})
```

Capability matching normalizes path separators and matches the whole resource. `Capability.subsumes` is deliberately conservative: it returns `false` when containment cannot be proven syntactically.

## Ambient authority

`CapabilitySet` represents the current envelope. Nested code can only narrow authority by intersection; it cannot widen the set inherited from its caller. `Workspace` provides the root used to resolve and normalize path capabilities.

Pure path manipulation is not permission-checked. Filesystem access derived from a path is.

## Grant stores

`GrantStore` supports `once`, `run`, `remembered`, and `deny` resolutions. `JournalGrantStore` persists grant events in the engine journal. `makeNoop` is an explicit allow-all seam, and test grant layers provide scripted behavior; a production deployment should install a deliberate policy.

The kernel is a capability check, not an operating-system sandbox.

## Process containment

A capability check decides whether a process may start. Containment decides what happens to it when the run that started it stops, and that is a separate mechanism with a separate failure mode.

Cancellation already cascades: the engine interrupts the run fiber, the fiber closes the action scopes, and Effect's spawner signals the child a scope owned. Two gaps sit under that. Effect signals once and then waits for the exit, so a child that traps `SIGTERM` parks the releasing fiber and the run never reaches `cancelled`. And a host killed outright runs no finalizer at all, so every process it started keeps running with nobody left holding a handle.

`@smthrs/kernel`'s `ContainedSpawner` closes the first gap by giving every command it spawns an escalation deadline, `SIGTERM` and then `SIGKILL` after `graceMs`. It closes the second by writing each spawn to the `ProcessLedger`. Ledger records are ownerless journal entries on the run `flows.host:<hostId>`, so the next incarnation of the same host replays them, subtracts the exits, and learns which process groups an owner it can prove is dead abandoned. `@smthrs/platform-node`'s `ProcessReaper` kills those groups on host start and journals the reap.

A spawn whose record did not commit is refused rather than started: the child is signalled and the caller is told. A ledger that quietly degraded to memory would leave exactly the child nobody can find, which is the case containment exists for.

The reaper is deliberately hard to convince. A stored pid outlives the process that wrote it and the operating system reuses the number, so a record is signalled only when its owner is provably gone (`ESRCH`, never `EPERM`), its group is not this host's own, it was written during this boot, and the pid's start time still matches the record. Anything else is retired with `flows.host.process-reap-skipped.v1` and nothing is signalled; a kill that fails retires nothing at all, so the next incarnation tries again.

The engine gains no hook. Containment is entirely a host concern: the kernel records pids and process groups and knows nothing about runs, attempts, or ownership fences, and the platform bundle sends the signals. `jj` is contained the same way, because `NodeHost.layerContained` builds the `Jj` service over the contained spawner instead of letting it start children of its own. A remote sandbox reaches the same outcome through its provider's `kill`, described in the [`@smthrs/sandbox` reference](/api/sandbox).

Containment is not confinement. It ends processes this host started and recorded; it does not stop a process from double-forking out of its group or from being started by something other than the guarded spawner.

## Boundary capture: hermetic execution as a transaction

Hermetic execution needs more than a capability check: it needs to know what a
body *actually* read and wrote. Two contracts split that job:

- [`StepBoundary`](/api/engine-store#stepboundary) measures the
  declared read set before the body runs, captures the declared write set's
  post-state afterwards, and re-materializes those outputs on a cache hit. It
  can only look at paths it was told about.
- [`WorkspaceSandbox`](/api/engine-store#workspacesandbox) runs the
  body in an isolated **workspace transaction** instead. The transaction is
  seeded with exactly the declared read set: an undeclared file is not there
  to read, which is `docs/specs/Concepts/Effect Taxonomy.md`'s strong
  enforcement tier, and the body's writes accumulate in the transaction rather
  than on the host. Settlement is a whole-map diff, so "did this body write
  outside its declared write set" is a comparison rather than an inference.

The host is untouched until `materialize`, a compare-and-set on every changed
file's pre-image that applies the whole diff bundle or none of it. That is why
a sealed action composed this way may enter the shared step cache: its
evidence carries whole-tree write verification honestly. It is also why writes
reach the host at exactly one place, which is where the human diff-review gate
of `docs/specs/Concepts/Diff Review.md` will attach.

The transaction is a **deterministic transaction model, not a security
boundary**. A body that reaches the host through a service the transaction does
not seed, a spawned native process, an undecorated socket, is outside it.
Actually denying that ambient access now ships in the
[`@smthrs/sandbox` reference](/api/sandbox#sandbox): `Sandbox.Provider`
provisions the machine boundary, and `Sandbox.layerHost` supplies the held
machine's filesystem, process spawner, and paths instead of relying on a path
guard.

## Adapter limitations

- The browser layer wraps an injected ZenFS-like promises API and an injected just-bash interpreter, which must be mounted on the *same* filesystem.
- The browser spawner is buffered, cannot take stdin or be killed, and rejects custom shells, detached processes, and configured extra file descriptors rather than silently dropping them.
- Browser `Jj` has a real implementation: `@smthrs/jj/browser/BrowserJj`'s `layer({ fs, wasm })` drives jj-lib compiled to `wasm32-wasip1` over an injected virtual filesystem. `layerUnsupported` remains exported for a host that ships no wasm module; it fails in the error channel rather than omitting the tag, but the `BrowserHost` bundle wires the real layer: `layer({ bash, fs, jj })` takes the compiled module and the sync slice of the same mount, and a jj-less host is an explicit page choice, never the bundle's silent default.
- Hosted-adapter behavior and limitations are documented with those adapters
  in the external plugins repository.

See the [`@smthrs/jj`](/api/jj) and
[`@smthrs/sandbox`](/api/sandbox) references, and the
[`@smthrs/kernel` reference](/api/kernel).
