---
title: "The isolation attestation"
description: "What BrowserFileSystem.layer claims to the capability kernel that BrowserFileSystem.make does not: whole-filesystem isolation, why path resolution is safe under it, and why realPath carries the workspace boundary."
sidebar:
  order: 2
---

`BrowserFileSystem.make` and `BrowserFileSystem.layer` build the same service.
Only one of them makes a claim about your volume, and the claim is the reason
this package can be composed under the capability kernel at all.

## What the kernel needs from a host filesystem

[`@smthrs/kernel`](/api/kernel) guards every filesystem operation against a
grant. Between checking a path and using it, a symlink can be swapped for one
pointing somewhere else, so a native host has to close that window with
descriptor-relative operations: open the workspace root once, then traverse from
that descriptor without re-resolving names. A host that offers no such executor
fails closed.

A mounted virtual volume is in a different position. It cannot name a path
outside itself under any circumstance, because there is no outside: the whole
addressable namespace is the mount. For that case the kernel accepts an
attestation, `withIsolatedFileSystem`, which says exactly that, and lets the
guarded surface resolve paths directly.

## `layer` attests, `make` does not

```ts
import * as BrowserFileSystem from "@smthrs/platform-browser/BrowserFileSystem"

declare const fs: BrowserFileSystem.ZenFsPromisesLike

/** A Layer carrying the attestation. Compose this under the capability kernel. */
const attested = BrowserFileSystem.layer(fs)

/** The same service, with no claim attached. */
const bare = BrowserFileSystem.make(fs)
```

`layer(fs)` returns `withIsolatedFileSystem(make(fs))`. `make(fs)` returns the
service alone, for a caller that wants Effect's `FileSystem` and no kernel claim
attached to it. Nothing else distinguishes them, so the package's own suite
asserts the marker symbol is present on one and absent on the other.

Composing `layer` is therefore an assertion about the object you passed:

| You pass                       | The claim is                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| A mounted ZenFS volume         | True. IndexedDB, OPFS, and in-memory backends address nothing outside the mount.           |
| A rooted adapter over the host | True only if it re-roots every path itself, the way this package's shared-mount test does. |
| `node:fs/promises` directly    | False. It addresses the whole machine.                                                     |

Passing `node:fs/promises` is a test-time convenience for a process that is
itself the sandbox. It is never a production composition. When you want the
Effect service in a host process without the claim, use `make`.

The attestation is also refused rather than silently applied: if the filesystem
already carries a descriptor-relative executor, `withIsolatedFileSystem` throws
at composition time, because replacing the stronger guarantee with a
path-delegating one would reopen the window it closed.

## `realPath` is the boundary

Under the attestation the kernel resolves a guarded path through the host's own
`realPath` and then checks the grant against the result. That makes `realPath`
load-bearing rather than cosmetic: an implementation that echoed its input would
turn the workspace boundary into a naming convention, and a symlink could name a
resource outside it.

So this adapter canonicalizes for real. When the backend has `realpath`, it is
called, on a path made absolute without collapsing segments first, so the
backend follows a link before a later `..` chooses a parent. When the backend
has no `realpath`, it has no links to follow, and lexical normalization is
deliberately the whole answer; the path is still stat'ed, so a missing path
fails the way `realpath` fails.

`readLink` is one of the operations this adapter refuses. A volume that can hold
symlinks must therefore supply `realpath`, or the kernel has no way to resolve a
link before it checks a grant.

## Related reading

- [Capabilities and the host kernel](/docs/concepts/kernel/) on smithers.sh, for
  what a grant is and how it is checked.
- [Injected backends](./injected-backends.md), for the optional slice members
  this page depends on.
