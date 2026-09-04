---
title: "Test code that depends on Jj"
description: "Stub the Jj service with makeNoop and layerNoop, hand-write a partial implementation, and decide when a test needs a real jj binary instead."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/jj/docs/guides/testing.md"
---

`Jj` is a service, so a test that exercises code depending on it swaps the
layer rather than the code. The package ships the stubs for that, and the
default they choose is deliberate.

## Stub everything, then override what the test needs

```ts
import { layerNoop } from "@smthrs/jj"
import * as Effect from "effect/Effect"

const layer = layerNoop({
  snapshot: () => Effect.succeed({ changeId: "test-snapshot" })
})
```

`layerNoop(overrides)` provides `makeNoop(overrides)` as the `Jj` layer. Every
method not overridden fails with `JjError` `not_installed`, naming the method
that was called:

```text
not_installed: Jj.status: jj is not available on this host
```

The failing default is the point. A test that stubs only `snapshot` gets a
named failure the moment the code under test reaches `restore`, instead of a
silent success that hides a call the test never meant to allow.

Both optional operations are stubbed too, so reaching one gives you the named
failure rather than "undefined is not a function".

Use `makeNoop` directly when you want the service value instead of a layer, for
example to call a method in a unit test with no Effect context.

## Hand-write an implementation

`root` and `revert` are optional on the interface, so a double may define the
six required members and nothing else. This is the stub the repository's own
examples use, where the engine calls jj for compensable snapshots and the
examples all use sealed actions:

```ts
import { Jj, make } from "@smthrs/jj"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const stubJj = Layer.succeed(
  Jj,
  make({
    snapshot: () => Effect.succeed({ changeId: "examples-snapshot" }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)
```

`make` brands the implementation as the service, so a new backend is checked
where it is written rather than where it is provided.

## Do not feature-detect by property

`"revert" in jj` is true for `makeNoop`, for `BrowserJj.make`, and for
`BrowserJj.layerUnsupported` alike, because every shipped layer defines both
optional members. Code that needs to know whether a host can revert calls the
method and reads the code:

```ts
import { isJjError, Jj } from "@smthrs/jj"
import * as Effect from "effect/Effect"

const canRevert = (changeId: string) =>
  Effect.gen(function*() {
    const jj = yield* Jj
    return yield* jj.revert!(changeId).pipe(
      Effect.as(true),
      Effect.catch((failure) =>
        isJjError(failure) && failure.code === "not_installed"
          ? Effect.succeed(false)
          : Effect.fail(failure)
      )
    )
  })
```

Test both arms with `layerNoop({})`, which reports `not_installed`, and with a
stub that succeeds.

## When a test needs a real jj

Stubs cannot prove anything about jj itself: argv quoting, the vocabulary the
adapter classifies, whether a restore merges or replaces. Those need a real
binary and a throwaway repository:

```ts
import { execFileSync } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repository = await mkdtemp(join(tmpdir(), "jj-suite-"))
execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
```

Provide `NodeJj.layerAt(repository)` rather than `NodeJj.layer`, so the suite
cannot be redirected by another test's `process.chdir`.

Two habits from this package's own suite are worth copying:

- **Do not let the suite silently skip.** Guard on whether jj is installed, and
  on continuous integration turn the skip into a loud failure. A behavioral
  regression that merges because the only suite exercising the real contract
  no-opped is the failure mode this guards against.
- **Set `JJ_EDITOR` to a marker script**, not to `true`. `jj describe` without
  `-m` starts the editor and waits for it, and `true` hides that behind a
  program that exits immediately. A marker file makes "no jj this layer runs
  ever opened an editor" an assertion instead of a hang.

## Testing browser code

`BrowserJj` needs a synchronous filesystem, and `node:fs` behind a rooted
adapter satisfies the same structural slice ZenFS does. That is how this
package tests the wasm layer under Node, and it is why `WasiFs` names a shape
rather than importing a backend.

For a browser host that ships no wasm module, `BrowserJj.layerUnsupported` is
the layer to provide: every operation reports `not_installed` with the jj
command the CLI adapter would have run.
