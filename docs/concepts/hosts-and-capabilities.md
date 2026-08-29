# Hosts and capabilities

This page describes the portable host surface and the permission kernel that mediates side effects. It covers engine-facing filesystem, process, network, and workspace operations, not higher-level application policy.

## The closed host surface

`@smthrs/kernel` owns the closed list — `HostServiceTags` and `HostServiceIds` — of these protected services:

- Effect `FileSystem`
- Effect `Path`
- Effect `ChildProcessSpawner`
- `Jj` (contract in [`@smthrs/jj`](../reference/jj.md))
- Effect `HttpClient`

Four of the five slots hold Effect's own tags. `flows` used to define a `Shell` service in the third slot; it was `effect/unstable/process` with fewer features, so it was deleted and the slot now holds `effect/process/ChildProcessSpawner` (see [design decisions](../pages/design-decisions.md)). The fifth slot went the same way: a `flows`-defined one-hop `HttpTransport` was deleted in favour of `effect/HttpClient`. `flows` supplies implementations of both — Node, Bun, an in-browser one, and a remote one — and adds only the capability check.

The list is closed, not the package: `Jj` ships as its own package so a consumer that only needs that capability does not take the whole host surface. The contract stays in `@smthrs/jj`; the kernel decorates that same tag (and re-exports it for convenience) rather than declaring a second one, and the composite bundles (`NodeHost`, `BunHost`, `BrowserHost`, `TestHost`) provide all five tags. There is no pseudo-terminal service: interactive-terminal support is out of core by design (see [design decisions](../pages/design-decisions.md)).

Clock and Random are tracked as host built-ins. This workspace ships Node,
Bun, browser, and deterministic test layers for the same service tags.
Cloudflare and Vercel adapters live in the separate
[plugins repository](https://github.com/smithersai/plugins). Unsupported
operations fail through their service contract; they should not disappear
from the environment type.

Host bundles provide an `HttpClient` that never follows a redirect on its own — the fetch layers are configured with `RequestInit { redirect: "manual" }`, and Undici installs no redirect interceptor. Redirect following belongs *above* the kernel's guard: the decorator composes Effect's own `HttpClient.followRedirects` over the checked client, so every network hop is authorized independently.

## Kernel decoration

The kernel decorates each service tag in place — a middleware `Layer` over the very tag the platform adapter provides, so there is no second "protected" tag to reach around. Each decorator:

1. derives an exact `Capability`,
2. asks `GrantStore` to authorize it,
3. calls the raw platform port only when allowed.

Where Effect owns the tag (`FileSystem`, `ChildProcessSpawner`) the error channel stays `PlatformError`: a refused operation surfaces with reason `PermissionDenied`, and the structured kernel failure rides on its `cause`, recoverable with `Permission.fromPlatformError`. `HttpClient` does the same in Effect's network channel: a refusal is an `HttpClientError` whose reason is a `TransportError` carrying the kernel failure on `cause`, recoverable with `HttpClient.fromHttpClientError`. Where `flows` owns the service (`Jj`) the interface names `Permission.PermissionError` directly.

For a spawn, the exact capability is `proc:spawn` with `CommandLine.render(command)` as its resource — the same string a browser interpreter or a remote sandbox is handed for supported commands, so a grant and the thing it authorizes cannot drift apart. A custom shell path is included explicitly in the resource; adapters that cannot select it reject the command.

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

## Boundary capture: hermetic execution as a transaction

Hermetic execution needs more than a capability check — it needs to know what a
body *actually* read and wrote. Two contracts split that job:

- [`StepBoundary`](../reference/engine-store.md#stepboundary) measures the
  declared read set before the body runs, captures the declared write set's
  post-state afterwards, and re-materializes those outputs on a cache hit. It
  can only look at paths it was told about.
- [`WorkspaceSandbox`](../reference/engine-store.md#workspacesandbox) runs the
  body in an isolated **workspace transaction** instead. The transaction is
  seeded with exactly the declared read set — an undeclared file is not there
  to read, which is `docs/specs/Concepts/Effect Taxonomy.md`'s strong
  enforcement tier — and the body's writes accumulate in the transaction rather
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
not seed — a spawned native process, an undecorated socket — is outside it.
Actually denying that ambient access is the VM/`SandboxProvider` provisioning
story in `docs/specs/Concepts/Agent Adapters.md`, and it is future work.

## Adapter limitations

- The browser layer wraps an injected ZenFS-like promises API and an injected just-bash interpreter, which must be mounted on the *same* filesystem.
- The browser spawner is buffered, cannot take stdin or be killed, and rejects custom shells, detached processes, and configured extra file descriptors rather than silently dropping them.
- Browser `Jj` has a real implementation: `@smthrs/jj/browser/BrowserJj`'s `layer({ fs, wasm })` drives jj-lib compiled to `wasm32-wasip1` over an injected virtual filesystem. `layerUnsupported` remains exported for a host that ships no wasm module — it fails in the error channel rather than omitting the tag — but the `BrowserHost` bundle wires the real layer: `layer({ bash, fs, jj })` takes the compiled module and the sync slice of the same mount, and a jj-less host is an explicit page choice, never the bundle's silent default.
- Hosted-adapter behavior and limitations are documented with those adapters
  in the external plugins repository.

See the [`@smthrs/jj`](../reference/jj.md) and
[`@smthrs/sandbox`](../reference/sandbox.md) references, and the
[`@smthrs/kernel` reference](../reference/kernel.md).
