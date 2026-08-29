# @smthrs/platform-bun

The Bun Host bundle for `flows`.

`@effect/platform-bun` re-exports the `@effect/platform-node` filesystem and
child-process spawner unchanged and ships Effect's fetch-backed `HttpClient`,
so this package adds no implementation of its own: it composes the complete
closed five-tag Host surface, including the Bun `Jj` adapter from
`@smthrs/jj`.

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
runtime detection here either — the bundle works unchanged under Node, which is
what vitest and CI run.

There is no HTTP service either. An outgoing request is Effect's `HttpClient`,
and the bundle provides `@effect/platform-bun`'s own fetch-backed layer with
`RequestInit { redirect: "manual" }`, so nothing walks to a second origin
behind the capability kernel's back. Bun does **not** depend on
`@smthrs/platform-browser` to reach `fetch`.

## Modules

| Module          | What it provides                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `BunHost`       | The complete closed Host bundle, plus `layer`; re-exports Effect's `BunChildProcessSpawner` and `BunHttpClient` |
| `BunFileSystem` | Bun's `FileSystem`, which is Effect's Node implementation                                                       |

**No atomic filesystem adapter yet.** `BunFileSystem.layer` is the raw
`@effect/platform-node` filesystem, so it carries no descriptor-relative,
no-follow extension. Under `@smthrs/kernel`'s `FileSystem.layer` every
path operation therefore fails closed with a typed `PermissionDenied` instead
of performing a check-then-path operation that a symlink swap could redirect.
`@smthrs/platform-node`'s `AtomicFileSystem.layer` is the adapter Bun
needs; wiring it here is tracked work, not a supported configuration today.

**Node-only by construction.** The bundle falls back to the
`@effect/platform-node` adapters off Bun and resolves `node:` built-ins;
`scripts/browser-check.mjs` at the repository root pins that.
