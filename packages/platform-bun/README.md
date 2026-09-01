# @smthrs/platform-bun

The Bun Host bundle for Smithers.

`@effect/platform-bun` re-exports the `@effect/platform-node` child-process
spawner unchanged and ships Effect's fetch-backed `HttpClient`, so this package
writes no spawner and no HTTP client of its own: it composes those with Effect's
`Path`, the Bun `Jj` adapter from `@smthrs/jj`, and `@smthrs/platform-node`'s
atomic filesystem into the complete closed five-tag Host surface.

`@effect/platform-bun` is a peer dependency that the root and `BunHost` entry
points import at module load, and it is declared optional, so a package manager
will not install it for you. Install it alongside this package:

```sh
npm install @smthrs/platform-bun @effect/platform-bun@4.0.0-rc.108
```

Without it the first `import { BunHost } from "@smthrs/platform-bun"` throws
`ERR_MODULE_NOT_FOUND` for `@effect/platform-bun/BunChildProcessSpawner`. Only
`@smthrs/platform-bun/BunFileSystem` resolves on its own.

```ts
import { BunHost } from "@smthrs/platform-bun"
import { Effect } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("git", ["status", "--short"]))
})

Effect.runPromise(Effect.provide(program, BunHost.layer))
```

There is no shell service. Running a command is Effect's `ChildProcess` /
`ChildProcessSpawner`; because Bun's spawner _is_ the Node one, there is no
runtime detection here either, and the bundle works unchanged under Node, which
is what every test here runs on. The `//ci:platformBun` target re-runs these
files through Bun's package runner (`bun x vitest`, with no `--bun`), but the
`vitest` bin that resolves to is pnpm's `/bin/sh` shim, and every branch of it
`exec`s `node`, so that lane executes under Node as well. Running this suite on
the Bun runtime is tracked work, not something the repository does today.

There is no HTTP service either. An outgoing request is Effect's `HttpClient`,
and the bundle provides `@effect/platform-bun`'s own fetch-backed layer with
`RequestInit { redirect: "manual" }`, so nothing walks to a second origin
behind the capability kernel's back. Bun does **not** depend on
`@smthrs/platform-browser` to reach `fetch`.

`BunHost.layerContained` is the bundle with process containment turned on:
`@smthrs/kernel`'s `ContainedSpawner` gives every child a
`SIGTERM`-then-`SIGKILL` deadline and a `ProcessLedger` entry, and
`@smthrs/platform-node`'s `ProcessReaper` sweeps the entries a crashed
incarnation of this host left behind. The reaper lives in the Node package
because the calls it makes, `process.kill` and `taskkill`, are Node's, and
Bun implements them unchanged. `layerContained` also builds `Jj` over the
contained spawner (`BunJj.layerSpawner`), so a `jj` a crashed host left running
is a ledger record like any other.

`BunHost.layerAt` and `BunHost.layerContainedAt` are the same two layers with
`Jj` bound to one absolute repository root instead of the process working
directory. Both refuse a relative root.

Both contained factories take `BunHost.ContainedOptions`: the escalation
deadline plus the reaper's `ownerPid` and system seam. `platform` is not part of
it, because the spawner underneath decides whether a child leads a process group
from the real `process.platform` whatever it is told, so a caller-supplied value
could only make the ledger record `pgid: null` for a child that genuinely leads
one, which `ProcessReaper` then retires without signalling anything.

## Modules

| Module          | What it provides                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BunHost`       | The closed Host bundle: `layer`, `layerAt`, `layerContained`, `layerContainedAt`; re-exports `AtomicFileSystem`, `BunChildProcessSpawner`, `BunFileSystem`, and `BunHttpClient` |
| `BunFileSystem` | `@smthrs/platform-node`'s atomic `FileSystem`, plus `layerWith` for a host whose python3 lives elsewhere                                                                        |

**The filesystem slot is the atomic adapter.** `BunFileSystem.layer` _is_
`@smthrs/platform-node`'s `AtomicFileSystem.layer`, the same layer behind
`NodeHost`'s filesystem slot, so under `@smthrs/kernel`'s `FileSystem.layer`
every guarded path operation runs descriptor-relative and no-follow rather than
failing closed with a typed `PermissionDenied`. That extension executes its
syscalls through a CPython 3 helper: the host needs a `python3` supporting
`O_NOFOLLOW`, `O_DIRECTORY`, and `dir_fd` at `/usr/bin/python3`. A host that
keeps it elsewhere builds the layer with `BunFileSystem.layerWith({ executable })`.
Windows is unsupported.

**Node-only in the browser-bundle sense.** The bundle falls back to the
`@effect/platform-node` adapters off Bun and so resolves `node:` built-ins,
which puts it on `scripts/browser-contract.mjs`'s `NODE_ONLY` list;
`scripts/browser-check.mjs` at the repository root pins that. It runs on Bun and
on Node. What it does not do is bundle for a browser.

## Runtimes

Bun >=1.3.0 and Node.js >=22.19.0.
