## Entry points

| Import                               | Source                                                                                                                    | Platform |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------- |
| `@smthrs/kernel`                     | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/index.ts)                             | any      |
| `@smthrs/kernel/test/TestGrantStore` | [src/test/TestGrantStore.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/test/TestGrantStore.ts) | any      |
| `@smthrs/kernel/test/TestHost`       | [src/test/TestHost.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/test/TestHost.ts)             | Node.js  |
| `@smthrs/kernel/test/contract`       | [src/test/HostContract.ts](https://github.com/smithersai/smithers/blob/main/packages/kernel/src/test/HostContract.ts)     | Node.js  |

## Capability and permission policy

`Capability` and `Permission` are namespace re-exports from
[`@smthrs/capability`](/api/capability). That package owns their vocabulary,
pattern grammar, policy evaluation, effect tiers, and typed failure contract.
This page documents how the kernel applies that contract at host boundaries.

Rules are ordered and last-match-wins, except an effective configured deny is
a hard veto. The default decision is `ask`. `CapabilitySet` supplies the
ambient authority ceiling, and its public operations can only preserve or
narrow authority.

```ts
import { Capability, Permission } from "@smthrs/kernel"

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

### Grant decisions and replay

`GrantStore` resolutions are `once`, `run`, `remembered`, and `deny`.
Attended stores suspend the asking fiber on its request; unattended stores
fail immediately with `PermissionRequired`. `makeNoop` is an explicit
allow-all seam, not a production policy.

The durable `GrantEvent` union has exactly five wire shapes: `OnceGrant`,
`RunGrant`, `RememberedGrant`, `DeniedGrant`, and `EnvelopeGrant`. Envelope
patterns are treated as a set: `canonicalEnvelopePatterns` deduplicates and
sorts them, and `envelopeSignature` gives the canonical plan, scope, and
pattern-set identity used to prevent duplicate persistence.

`JournalGrantStore` persists a decision before activating it. A persistence
failure is `journal_failed` and leaves the decision inactive. Replay accepts
only the configured producer and known event types, rejects malformed or
mis-scoped events, treats once and denied events as audit evidence only, and
activates a run grant only for its run and current plan digest. Remembered
rules come from the dedicated policy run and are deduplicated before store
construction. A policy history past the 1,024-rule ceiling fails closed and
names the policy run and the relevant counts.

## Decorator model

`FileSystem`, `ChildProcessSpawner`, `Jj`, and `HttpClient` provide middleware
layers over the same service tags supplied by the platform adapter. There is
no second protected tag. Composing a decorator over a raw host layer shadows
that raw implementation for every consumer of the original tag.

For Effect-owned services, filesystem and process permission failures are
projected into `PlatformError`, while network failures are projected into
`HttpClientError`. The structured kernel failure remains on `cause` and can be
recovered with `Permission.fromPlatformError` or
`HttpClient.fromHttpClientError`. `Jj` owns its interface and names
`PermissionError` directly. `Path` is pure path manipulation and is passed
through without a capability check.

`HostServices.layer` composes the closed protected surface at the application
boundary:

```text
raw platform service
        |
kernel decorator -> GrantStore
        |
flow-visible service
```

### Filesystem canonicalization and atomic hosts

A checked pathname is not handed unchanged to a path-based host. Before a
grant check, `canonicalResource` resolves every existing ancestor, maps a
canonical path inside the workspace back to the stable logical workspace
root, and refuses unsafe hard-linked files. After any grant suspension, the
kernel resolves the resource again and refuses the operation if the path now
names something else. Open handles bind authorization to the descriptor's
`device:inode` identity and recheck that identity on guarded handle
operations.

Native hosts attach a descriptor-relative, no-follow executor with
`withAtomicFileSystem`. Browser and test volumes that cannot address the host
filesystem may attest whole-volume isolation with `withIsolatedFileSystem`.
Both decorate the service object in place, so a host attaches once at its
boundary. `withIsolatedFileSystem` refuses a filesystem that already carries a
descriptor-relative executor: that executor is the stronger guarantee, and the
path-delegating attestation would reopen the symlink-swap window the extension
closes. Layering over an executor a caller has read and delegates to stays
allowed, because that replacement is the caller's own decision. A host
declaring neither extension fails every relevant path, directory, stream,
glob, and handle operation closed.

An implicit `makeTempDirectory`, `makeTempDirectoryScoped`, `makeTempFile`, or
`makeTempFileScoped` is authorized as `fs:write` on
`path.resolve(workspace.root, "..", "<system-temp>")`. That sentinel is
outside the workspace root by construction, so granting an ordinary workspace
write does not grant system temporary-directory access. The fail-closed
description for a host without the required extension names the logical input
`../<system-temp>`.

### HTTP resources and redirects

The decorator guards Effect's `HttpClient`; there is no Smithers transport
port beneath it. GET and HEAD use `net:get`, and every other method uses
`net:post`. For an `https:` URL, the resource is the lowercased URL host. For
any other scheme, the resource is `<scheme>//<lowercased host>`. In other
words, `https` is the implicit scheme: `https://EXAMPLE.test/x` names
`example.test`, while `http://EXAMPLE.test/x` names `http://example.test`.
A grant for the host therefore never authorizes a cleartext `http` downgrade.

Inside `HttpClient.withModelCall(modelId)`, the action is `model:call` and the
same scheme rule applies, with `/<model id>` appended to the resource.
Redirects are followed above the guard, and platform clients do not follow
redirects on their own, so every hop re-enters authorization independently.

### Process grant identity

A spawn is checked as `proc:spawn` with `CommandLine.render(command)` as its
resource. A custom shell path is explicit in that line, and a pipeline renders
with `|` between its stages. Derived process helpers are rebuilt from guarded
`spawn`, so they cannot bypass the check.

The grant identity is the rendered command line alone. The working directory,
environment overrides, and pipeline `from`/`to` routing are not part of what a
grant authorizes. `cwd` and the names of overridden environment variables
reach an attended surface as display metadata only.

## Process containment

Cancelling a run must leave no process running. `ContainedSpawner.layer`
rewrites each command to request `SIGTERM` and then `SIGKILL` after `graceMs`
(2,000 ms by default). Both legs of a pipeline receive the policy, while an
explicit caller-supplied `killSignal` or `forceKillAfter` is preserved.

Every successful spawn is recorded in `ProcessLedger` and released when its
scope closes. Durable records are ownerless journal entries on
`flows.host:<hostId>` under source id `@smthrs/kernel/ProcessLedger`. The next
incarnation of the same host replays the run and obtains `orphans`, the records
left by a dead owner. `layerMemory` keeps only the current incarnation's
bookkeeping.

A spawn whose durable record fails is signalled, fails the call, and leaves no
pid in `ProcessLedger.live`. The release finalizer is registered before the
spawn so it runs after Effect's kill finalizer. If that release write still
fails after retries, the record remains inherited for the next reaper rather
than claiming that a possibly live process exited.

The Node reaper signals an abandoned process only after it verifies that the
record names a separate process group, not the host's group; the owner is
gone; the record belongs to the current boot; and, where available, the pid
start time still matches. A successful reap and a safety refusal retire the
record with different durable event types. A failed signal or a still-live
owner leaves the record for a later attempt.

## Identity, failures, and bounds

Capability actions and resources, patterns, run IDs, plan digests, request
IDs, and grant metadata are identity-bearing values. Smithers does not apply
Unicode normalization: matching, signatures, and journal replay use the exact
JavaScript string and UTF-16 code-unit sequence supplied. Identity fields that
require well-formed text reject lone surrogates and NUL where their contract
forbids it.

Permission failures retain stable codes: `permission_required`,
`permission_denied`, and the `GrantStoreErrorCode` values
`duplicate_request`, `request_not_found`, `journal_failed`, `store_closed`,
and `invalid_resolution`. Platform projections preserve the structured value
as their cause.

One store retains at most 1,024 policy rules, 256 patterns per envelope, and
1,024 pending requests. Metadata is limited to 16 levels, 1,024 members, and
64 KiB of canonical JSON. An encoded event is limited to 256 KiB. Run, plan,
request, and signature identities are limited to 4,096 UTF-16 code units, and
capability resources share the capability package's 4,096-unit limit. Every
GrantStore bound failure uses `invalid_resolution` and occurs before state or
journal authority changes.

## What the kernel does not do

:::warning
The kernel checks capabilities at adapter call sites. It does not sandbox the
operating system and cannot observe host access that bypasses the decorated
services. Hermetic execution additionally requires a `StepBoundary`.
:::

## Testing

`@smthrs/kernel/test/TestGrantStore` supplies allow, deny, and scripted grant
layers. `@smthrs/kernel/test/TestHost` supplies the deterministic Node test
bundle. `@smthrs/kernel/test/contract` registers the shared filesystem,
process, Jj, and HTTP capability matrices for third-party host adapters.

See [Hosts and capabilities](/concepts/hosts-and-capabilities) and the platform
bundles that satisfy these ports: [`@smthrs/platform-node`](/api/platform-node),
[`@smthrs/platform-browser`](/api/platform-browser), and
[`@smthrs/platform-bun`](/api/platform-bun).
