# @smthrs/kernel

The closed host boundary and the capability kernel over it. This package owns
the closed list of platform ports every side effect enters through, monotone
authority, typed permission/grant decisions, journal-backed grants, and
permission-aware replacements for every protected Host service.

The implementations behind those ports live in `@smthrs/platform-node`,
`@smthrs/platform-bun`, and `@smthrs/platform-browser`. Four of the five ports
are Effect's own tags — `FileSystem`, `Path`, `ChildProcessSpawner`, and
`HttpClient` — so Smithers supplies implementations of them rather than wrappers
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

| Namespace             | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Capability`          | Re-export of `@smthrs/capability/Capability`: `Action`, exact `Capability`, `PatternAction`, and `CapabilityPattern`; `make`, `format`, `parse`, `parsePattern`, `patternFromCapability`, `withinMatchBudget`, `matches`, and `subsumes`; `EffectTier`, `TierOptions`, `tierOf`, and `requiresIdempotencyKey`.                                                                                                                                                                                                                                                                     |
| `CapabilitySet`       | `CapabilitySet`; `fromPatterns`, empty authority `none`, `allows`, `intersect`, `equals`, ambient `current`, and monotone `attenuate`. No widening constructor or unrestricted value is public.                                                                                                                                                                                                                                                                                                                                                                                    |
| `Permission`          | Re-export of `@smthrs/capability/Permission`: `PermissionRequired`, `PermissionDenied`, `GrantStoreErrorCode`, `GrantStoreError`, and the `PermissionError` union; policy `RuleEffect`, `Rule`, and `evaluate`; constructors `permissionRequired` and `permissionDenied`; `isPermissionError`, `formatError`, and the `PlatformError` projection `toPlatformError` / `fromPlatformError`.                                                                                                                                                                                          |
| `GrantEvent`          | `GrantTier`, `GrantScope`, `OnceGrant`, `RememberedGrant`, `RunGrant`, `DeniedGrant`, `EnvelopeGrant`, `GrantEventSchema`, `GrantEvent`, `decode`, and `encode`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GrantStore`          | `PendingRequest`, `Resolution`, `EnvelopeGrantOptions`, `Persist`, and `MakeOptions`; `Service` / `GrantStore` operations `check`, `reply`, `list`, and `grantEnvelope`; `canonicalEnvelopePatterns`, `envelopeSignature`, `isValidGrantPattern`, and `isValidEnvelopePattern`; limits `maximumRules`, `maximumEnvelopePatterns`, `maximumPendingRequests`, `maximumMetadataDepth`, `maximumMetadataMembers`, `maximumMetadataBytes`, `maximumEventBytes`, `maximumIdentityLength`, and `maximumCapabilityResourceLength`; `make`, `layer`, allow-all `makeNoop`, and `layerNoop`. |
| `JournalGrantStore`   | `JournalGrantStoreOptions`; `make` and `layer` replay and persist grants through `Journal`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `HostServices`        | The one closed list: `HostService`, `HostServiceTags`, `HostServiceIds`, and aggregate decorator `layer`. Each slot is decorated in place, so there is no second tag list.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `FileSystem`          | `canonicalResource`, the atomic-host extension, isolated-volume attestation, and decorator `layer` over Effect's own `FileSystem` tag. Path operations run only through a descriptor-relative/no-follow executor or an enforceably isolated filesystem; unsupported hosts fail closed with a typed permission error.                                                                                                                                                                                                                                                               |
| `HttpClient`          | Decorator `layer` over Effect's own `HttpClient` tag; the tag and `make` are re-exported unchanged, plus the `ModelCall` reference and `withModelCall`, the `toHttpClientError` / `fromHttpClientError` projection, and a `makeNoop` / `layerNoop` stub that reports the missing host as a `TransportError`.                                                                                                                                                                                                                                                                       |
| `ChildProcessSpawner` | Decorator `layer` over Effect's own `ChildProcessSpawner` tag; the tag and `make` are re-exported unchanged, plus a `makeNoop` / `layerNoop` stub that reports the missing host as a `NotFound` `PlatformError`.                                                                                                                                                                                                                                                                                                                                                                   |
| `ContainedSpawner`    | `defaultGraceMs`, `Options`, `withContainment`, `groupOf`, and decorator `layer` over Effect's own `ChildProcessSpawner` tag: every child gets a `SIGTERM`-then-`SIGKILL` deadline and a `ProcessLedger` entry released when its scope closes.                                                                                                                                                                                                                                                                                                                                     |
| `ProcessLedger`       | `SpawnedEventType`, `ExitedEventType`, `ReapedEventType`, `SkippedEventType`, `sourceId`, `hostRunId`, `Spawned`, `ProcessRecord`, `Options`; `Service` / `ProcessLedger` operations `record`, `release`, `reaped`, `skipped`, `live`, and `orphans`; `make`, `layer`, journal-free `makeMemory`, and `layerMemory`.                                                                                                                                                                                                                                                               |
| `CommandLine`         | `render`, `quote`, `cwd`, and `env` — one renderer shared by the `proc:spawn` capability resource and by the interpreters that execute the line.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Jj`                  | Decorator `layer` over `@smthrs/jj`'s own `Jj` tag; the tag, `make`, `makeNoop`, and `layerNoop` are re-exported unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `Path`                | Effect `Path` type/tag and explicit pass-through `layer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Workspace`           | `Service` / `Workspace` root configuration; `make`, `layer`, relative test value `makeNoop`, and `layerNoop`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Three public test subpaths are shipped:

- `@smthrs/kernel/test/TestGrantStore` exports `layerAllow`,
  `layerDeny(reason?)`, and `layerScripted(replies)`.
- `@smthrs/kernel/test/TestHost` exports the deterministic Host bundle,
  in-memory filesystem, scripted interpreter, seeded random layer, and
  `TestClock` composition.
- `@smthrs/kernel/test/contract` exports `runHostContract` and its complete
  FileSystem, process, Jj, and HTTP capability matrices for third-party Host
  adapters.

`test/TestHost` and `test/contract` are Node-only. The contract registers
Vitest cases and uses Node process/temp-directory fixtures, so consumers must
install the declared `@effect/vitest@4.0.0-rc.108` peer and `vitest@4.1.9`
(the latter is optional unless the contract subpath is imported).

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

`withAtomicFileSystem` and `withIsolatedFileSystem` decorate the supplied
service object in place and return that same identity. Compose them once at
the host boundary; do not retain an undecorated alias. `withIsolatedFileSystem`
throws on a service that already carries a descriptor-relative executor, so a
whole-volume attestation can never downgrade a native host to path delegation. The guarded filesystem,
HTTP, and child-process layers snapshot option records, nested arrays/maps, and
mutable request/byte buffers before any permission suspension, so mutation by
the caller cannot change the operation after authorization. `CapabilitySet`
and GrantStore results likewise own frozen copies rather than aliases to
caller state.

Network access is Effect's `HttpClient` — there is no Smithers transport port.
Consumers require `HttpClient.HttpClient` from `effect/unstable/http`, and the
kernel decorator shadows it. GET and HEAD are checked as `net:get`; every other
method is `net:post`. For `https:`, the resource is the lowercased URL host. For
any other scheme, it is `<scheme>//<lowercased host>`, so `https` is implicit
and a host grant cannot authorize a cleartext `http` downgrade. `model:call`
uses the same rule with `/<model id>` appended. A redirect is a second
destination, so the decorator composes Effect's `followRedirects` _above_ the
grant check: every hop is rechecked, and platform bundles hand over a client
that never follows a redirect on its own.

## Identity, failures, and bounds

Capability actions, resources, pattern resources, run IDs, plan digests, and
grant metadata are identity values. Smithers validates well-formed Unicode but
does not normalize it: comparison, hashing, signatures, and journal replay use
the exact JavaScript string/code-unit sequence supplied. Callers that want NFC
or another normalization must apply it before constructing the value.

Permission failures retain their stable public code:
`permission_required`, `permission_denied`, or one of
`duplicate_request`, `request_not_found`, `journal_failed`, `store_closed`, and
`invalid_resolution` in `GrantStoreErrorCode`. Platform adapters preserve the
structured failure as a cause when projecting it into `PlatformError` or
`HttpClientError`. Validation errors identify the rejected field but never
retain or print unbounded hostile input.

The in-memory GrantStore is deliberately finite: at most 1,024 policy rules,
1,024 activated envelope signatures, 256 patterns per envelope, and 1,024
pending requests. The envelope ceiling applies to the construction envelope as
well as to `grantEnvelope`, so replayed history cannot grow past what a later
construction is willing to read back. Metadata is limited to
16 levels, 1,024 members, and 64 KiB of canonical JSON; one encoded event is
limited to 256 KiB. Identity fields are at most 4,096 UTF-16 code units, and
capability resources use `Capability.maxResourceLength` (4,096). Exceeding a
GrantStore bound fails with `invalid_resolution` before state or the journal
changes.

## Process containment

The `proc:spawn` grant identity is `CommandLine.render(command)` alone. The
working directory, environment overrides, and pipeline `from`/`to` routing are
not part of what the grant authorizes. `cwd` and the names of overridden
environment variables reach an attended surface as display metadata only.

Cancelling a run must leave no process behind. Effect's spawner signals a
child's process group when the spawn scope closes and then waits for the exit,
and with no `forceKillAfter` it waits forever: a child that traps `SIGTERM`
turns a cancellation into a hung host. `ContainedSpawner.layer` closes that
hole by rewriting every command it spawns to carry an escalation deadline
(`SIGTERM`, then `SIGKILL` after `graceMs`, default 2000) and by recording the
started process in the `ProcessLedger`, releasing it when the scope closes.
Both legs of a pipeline get the same policy; a command that already names a
`killSignal` or `forceKillAfter` keeps the policy its caller chose.

The ledger is the durable half. Each spawn is written to `Journal` as an
ownerless record on the run `flows.host:<hostId>`, so the next incarnation of
the same host replays that history, subtracts the processes that reported an
exit, and reads `orphans`: the process groups an owner that is no longer alive
abandoned. `@smthrs/platform-node`'s `ProcessReaper` signals them.
`ProcessLedger.layerMemory` keeps the in-memory half without a journal, which
contains this incarnation and inherits nothing.

A ledger write that does not commit is reported, not swallowed. `record`,
`release`, `reaped`, and `skipped` all carry the journal's failure, and the
spawner refuses a spawn whose record failed: it signals the child and fails the
call, because a child no incarnation can discover is the exact outcome
containment exists to prevent. The one exception is the release finalizer, which
has nowhere to report anything; a missed release leaves the record inherited,
and the next reaper finds the pid already gone and retires it then.

The release is announced only after the process has been signalled. The
finalizer that retires a record is registered before the spawn, so scope closure
runs it after Effect's own kill finalizer.

`groupOf` takes the platform, because Effect detaches a child that names no
`detached` option everywhere except win32. A win32 record claiming `pgid = pid`
would name a group the child does not lead, so it records no group instead.

See the [kernel reference](https://github.com/smithersai/smithers/blob/main/docs/pages/api/kernel.md),
[host and capability concepts](https://github.com/smithersai/smithers/blob/main/docs/pages/concepts/hosts-and-capabilities.md),
and [step keys](https://github.com/smithersai/smithers/blob/main/docs/pages/concepts/step-keys.md).
