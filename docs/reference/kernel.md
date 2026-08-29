# `@smthrs/kernel`

This page is the public API reference for capability matching, permission decisions, durable grant handling, and permission-decorated host services. It does not provide an operating-system sandbox.

## Policy namespaces

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

## Decorated host namespaces

`FileSystem`, `ChildProcessSpawner`, `Jj`, and `HttpClient` export layers that depend on the corresponding raw platform port plus `GrantStore` and related context. `FileSystem`, `ChildProcessSpawner`, and `HttpClient` decorate Effect's own tags in place — the layer provides the same tag it requires, so there is no second kernel tag. `FileSystem` and `ChildProcessSpawner` project permission failures into `PlatformError` via `Permission.toPlatformError` (reason `PermissionDenied`, structured failure on `cause`, recovered with `Permission.fromPlatformError`); `HttpClient` projects them into `HttpClientError` via `HttpClient.toHttpClientError` (reason `TransportError`, structured failure on `cause`, recovered with `HttpClient.fromHttpClientError`). `Jj` decorates `@smthrs/jj`'s own tag, whose error channel already names the kernel's failures. `Path` explicitly re-exports the pure path-service decision without a permission check.

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

## Testing

`@smthrs/kernel/test/TestGrantStore` exports `layerAllow`, `layerDeny`, and `layerScripted`. The test module is a public deep import; internal modules are not.

See [Hosts and capabilities](../concepts/hosts-and-capabilities.md) and the platform bundles that satisfy these ports: [`@smthrs/platform-browser`](platform-browser.md), `@smthrs/platform-node`, and `@smthrs/platform-bun`.
