# @smthrs/kernel

The closed host boundary and the capability kernel over it. This package owns
the closed list of platform ports every side effect enters through, monotone
authority, typed permission/grant decisions, journal-backed grants, and
permission-aware replacements for every protected Host service.

The implementations behind those ports live in `@smthrs/platform-node`,
`@smthrs/platform-bun`, and `@smthrs/platform-browser`. Four of the five ports
are Effect's own tags — `FileSystem`, `Path`, `ChildProcessSpawner`, and
`HttpClient` — so `flows` supplies implementations of them rather than wrappers
around them.

```sh
pnpm add @smthrs/kernel
```

## Public API

The root exports these namespaces. Every module that lives in this package is
also available from its matching `@smthrs/kernel/*` subpath; `Capability` and
`Permission` are re-exports whose modules live in `@smthrs/capability`, so
their deep imports are `@smthrs/capability/Capability` and
`@smthrs/capability/Permission`.

| Namespace             | Public exports                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Capability`          | Re-export of [`@smthrs/capability/Capability`](../capability/README.md): `Action`, exact `Capability`, `PatternAction`, and `CapabilityPattern`; `make`, `format`, `formatPattern`, `parse`, `matches`, and `subsumes`; `EffectTier`, `TierOptions`, `tierOf`, and `requiresIdempotencyKey`.                                                                                                                         |
| `CapabilitySet`       | `CapabilitySet`; `fromPatterns`, empty authority `none`, `allows`, `intersect`, `equals`, ambient `current`, and monotone `attenuate`. No widening constructor or unrestricted value is public.                                                                                                                                                                                                                      |
| `Permission`          | Re-export of [`@smthrs/capability/Permission`](../capability/README.md): `PermissionRequired`, `PermissionDenied`, `GrantStoreErrorCode`, `GrantStoreError`, and the `PermissionError` union; policy `RuleEffect`, `Rule`, and `evaluate`; constructors `permissionRequired` and `permissionDenied`; `isPermissionError`, `formatError`, and the `PlatformError` projection `toPlatformError` / `fromPlatformError`. |
| `GrantEvent`          | `GrantTier`, `GrantScope`, `OnceGrant`, `RememberedGrant`, `RunGrant`, `DeniedGrant`, `EnvelopeGrant`, `GrantEventSchema`, `GrantEvent`, `decode`, and `encode`.                                                                                                                                                                                                                                                     |
| `GrantStore`          | `PendingRequest`, `Resolution`, `EnvelopeGrantOptions`, `Persist`, and `MakeOptions`; `Service` / `GrantStore` operations `check`, `reply`, `list`, and `grantEnvelope`; `isValidGrantPattern`, `isValidEnvelopePattern`, `make`, `layer`, allow-all `makeNoop`, and `layerNoop`.                                                                                                                                    |
| `JournalGrantStore`   | `JournalGrantStoreOptions`; `make` and `layer` replay and persist grants through `Journal`.                                                                                                                                                                                                                                                                                                                          |
| `HostServices`        | The one closed list: `HostService`, `HostServiceTags`, `HostServiceIds`, `HostBuiltinNames`, and aggregate decorator `layer`. Each slot is decorated in place, so there is no second tag list.                                                                                                                                                                                                                       |
| `FileSystem`          | `canonicalResource`, the atomic-host extension, isolated-volume attestation, and decorator `layer` over Effect's own `FileSystem` tag. Path operations run only through a descriptor-relative/no-follow executor or an enforceably isolated filesystem; unsupported hosts fail closed with a typed permission error.                                                                                                 |
| `HttpClient`          | Decorator `layer` over Effect's own `HttpClient` tag; the tag and `make` are re-exported unchanged, plus the `ModelCall` reference and `withModelCall`, the `toHttpClientError` / `fromHttpClientError` projection, and a `makeNoop` / `layerNoop` stub that reports the missing host as a `TransportError`.                                                                                                         |
| `ChildProcessSpawner` | Decorator `layer` over Effect's own `ChildProcessSpawner` tag; the tag and `make` are re-exported unchanged, plus a `makeNoop` / `layerNoop` stub that reports the missing host as a `NotFound` `PlatformError`.                                                                                                                                                                                                     |
| `CommandLine`         | `render`, `quote`, `cwd`, and `env` — one renderer shared by the `proc:spawn` capability resource and by the interpreters that execute the line.                                                                                                                                                                                                                                                                     |
| `Jj`                  | Decorator `layer` over `@smthrs/jj`'s own `Jj` tag; the tag, `make`, `makeNoop`, and `layerNoop` are re-exported unchanged.                                                                                                                                                                                                                                                                                          |
| `Path`                | Effect `Path` type/tag and explicit pass-through `layer`.                                                                                                                                                                                                                                                                                                                                                            |
| `Workspace`           | `Service` / `Workspace` root configuration; `make`, `layer`, relative test value `makeNoop`, and `layerNoop`.                                                                                                                                                                                                                                                                                                        |

The public `@smthrs/kernel/test/TestGrantStore` subpath exports `layerAllow`,
`layerDeny(reason?)`, and `layerScripted(replies)`.

```ts
import { Capability, GrantStore } from "@smthrs/kernel"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const grants = yield* GrantStore.GrantStore
  yield* grants.check(Capability.make("fs:read", "/workspace/README.md"))
}).pipe(Effect.provide(GrantStore.layerNoop))

Effect.runPromise(program)
```

`HostServices.layer` decorates the closed Host surface in place: composed over
a raw platform bundle, the guarded FileSystem, Path, ChildProcessSpawner, Jj,
and HttpClient implementations shadow the raw ones under the same tags. Where
Effect owns the tag (`FileSystem`, `ChildProcessSpawner`) a refused operation
surfaces as a `PlatformError` with reason `PermissionDenied` and the structured
kernel failure on `cause` (`Permission.fromPlatformError` reads it back);
`HttpClient` does the same one module out, projecting a denial into an
`HttpClientError` whose reason is a `TransportError` carrying the kernel
failure (`HttpClient.fromHttpClientError` reads it back). `Jj` keeps
`Permission.PermissionError` in its own channel.

Filesystem confinement does not authorize a checked pathname and then hand the
same pathname to the host. That pattern is vulnerable to symlink swaps. Native
hosts must attach `withAtomicFileSystem` with operations rooted at a pinned
descriptor; browser/test volumes that cannot address the host filesystem may
use `withIsolatedFileSystem`. A raw path-only adapter is unsupported and every
relevant read, write, directory, remove, rename, list, stat, glob, stream, and
handle operation fails closed.

Network access is Effect's `HttpClient` — there is no `flows` transport port.
Consumers require `HttpClient.HttpClient` from `effect/unstable/http`, and the
kernel decorator shadows it. A redirect is a second destination, so the
decorator composes Effect's `followRedirects` _above_ the grant check: every
hop is rechecked, and platform bundles hand over a client that never follows a
redirect on its own.

See the [kernel reference](../../docs/reference/kernel.md),
[host and capability concepts](../../docs/concepts/hosts-and-capabilities.md), and
[step keys](../../docs/concepts/step-keys.md).
