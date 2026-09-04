---
title: "Run where python3 is not at /usr/bin/python3"
description: "Point the filesystem slot's CPython 3 helper at a different interpreter with BunFileSystem.layerWith, and tune the helper's concurrency, timeout, and byte limits."
---

The filesystem slot carries the kernel's atomic host extension, and that
extension does not run in-process. Each guarded path operation is executed by a
CPython 3 helper the adapter spawns, which is what makes the operation
descriptor-relative and no-follow: a symlink swapped in after authorization
cannot redirect it somewhere else.

The default interpreter is `/usr/bin/python3`. An alpine image, a nix profile,
or a container that installs python somewhere else needs to say so.

## Point at a different interpreter

```ts
import { BunFileSystem } from "@smthrs/platform-bun"

const fileSystem = BunFileSystem.layerWith({ executable: "/nix/store/.../bin/python3" })
```

The interpreter must support `O_NOFOLLOW`, `O_DIRECTORY`, and `dir_fd`. Confirm
the one you are naming actually runs:

```bash
/nix/store/.../bin/python3 -c "import os; print(os.O_NOFOLLOW, os.O_DIRECTORY)"
```

The executable is re-validated on every request rather than read once when the
layer is built, because the file a path names can be replaced while the host
runs.

## Use it as the whole host's filesystem slot

`BunHost.layer` builds its filesystem slot from `BunFileSystem.layer`, which is
the default interpreter. Merge your configured layer over the bundle so it
shadows that slot, and put it last: for a duplicate tag, the later layer in a
merge wins.

```ts
import { BunFileSystem, BunHost } from "@smthrs/platform-bun"
import * as Layer from "effect/Layer"

// The override comes second. Reversing the arguments silently keeps the
// default interpreter.
const host = Layer.merge(
  BunHost.layer,
  BunFileSystem.layerWith({ executable: "/opt/python3/bin/python3" })
)
```

This replaces the `FileSystem` tag every consumer resolves, including the
kernel's guarded `FileSystem.layer`, which is where the helper actually runs.
The spawner inside the bundle keeps the default filesystem layer it was built
with for resolving executables and working directories; that path is unguarded
and does not use the helper.

Prefer this over hand-composing the five slots. Rebuilding them yourself means
rebuilding the `HttpClient` slot too, and its `redirect: "manual"` wiring is
internal, so a hand-composed bundle quietly gains redirect following.

`BunHost` also re-exports `AtomicFileSystem` itself, so you can reach the
implementation and its full option set without adding
[`@smthrs/platform-node`](/api/platform-node) as a second dependency:

```ts
BunHost.AtomicFileSystem.layerWith({ executable, concurrency, timeoutMs })
```

## The other options

`BunFileSystem.Options` is `AtomicFileSystem.Options`:

| Field         | Meaning                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `executable`  | The CPython 3 interpreter to spawn. Default `/usr/bin/python3`. Re-validated per request.              |
| `concurrency` | How many helper processes may run at once. A contract, not a tuning knob: every operation is one fork. |
| `timeoutMs`   | How long one helper may run before it is killed and the operation fails closed.                        |
| `limits`      | The byte ceilings the helper enforces on the values it moves.                                          |

`concurrency` exists because one fork costs roughly 130 ms on a current host,
so an unbounded `Effect.forEach` over a directory would start one interpreter
per entry and pin every core. Raise it deliberately, with the fork cost in
mind.

Everything except `executable` is snapshotted when the layer is built. The
options object stays yours, and a byte ceiling that changed under a running
host would not be a ceiling.

## Windows

The extension is unsupported on Windows. The slot has no descriptor-relative
helper there, so a guarded path operation fails closed rather than running
against file descriptors.

## Related

- [The Host surface on Bun](../concepts/host-surface.md): why the filesystem
  slot is the Node package's implementation, and what the extension buys under
  the kernel's guard.
- [`@smthrs/platform-node`](/api/platform-node): the `AtomicFileSystem` adapter
  itself, its full option set, and its refusal matrix.
