---
title: "Testing"
description: "Test code that runs on @smthrs/platform-browser without a browser: satisfy the filesystem slice with node:fs/promises, stub the interpreter with an object literal, and pin error tags with a throwing backend."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-browser/docs/testing.md"
---

Both backends are structural slices, so a test satisfies them with ordinary
objects. Nothing here needs a browser, `@zenfs/core`, or just-bash: the seam
that keeps this package's dependency list short is the same seam that makes it
testable.

## Satisfy the filesystem slice with node:fs/promises

`ZenFsPromisesLike` names the members the adapter calls, under the names Node
uses, so Node's own `node:fs/promises` satisfies it. Point a test at a temp
directory and the filesystem contract runs against a real filesystem rather than
against a second in-memory implementation you would then have to keep honest:

```ts
import { BrowserFileSystem } from "@smthrs/platform-browser"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as NodeFsPromises from "node:fs/promises"

const read = Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString("/tmp/notes.txt")).pipe(
  Effect.provide(BrowserFileSystem.layer(NodeFsPromises))
)
```

Paths are absolute host paths here, because the volume is the machine. To give
a test a boundary of its own, root the slice: wrap each member so it joins a
temp directory in front of the path it was given, and answer `realpath` inside
the virtual namespace by stripping the canonical host root back off. Then the
test asserts the paths your program uses, such as `/workspace/notes.txt`, rather
than whatever temp directory the machine handed it.

## Stub the interpreter with an object literal

`JustBashLike` has one member, `exec`, so a stub is an object literal holding
one function. Returning the command line as `stdout` makes the rendered line
observable in the assertion:

```ts
import { BrowserChildProcessSpawner } from "@smthrs/platform-browser"

const bash: BrowserChildProcessSpawner.JustBashLike = {
  exec: async (commandLine) => ({ stdout: commandLine, stderr: "", exitCode: 0 })
}
```

Record the calls when the test is about what the adapter passed on, rather than
about what came back. `cwd`, `env`, and `replaceEnv` are the three fields worth
capturing: `replaceEnv` is the one that inverts a caller's environment semantics
if the adapter gets it wrong.

## Provide both together

`BrowserServices.layer` takes the pair, so a test composes the same way a page
does:

```ts
import { BrowserChildProcessSpawner, BrowserServices } from "@smthrs/platform-browser"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as NodeFsPromises from "node:fs/promises"

/** The stub from the previous section. */
declare const bash: BrowserChildProcessSpawner.JustBashLike

const output = Effect.flatMap(
  ChildProcessSpawner,
  (spawner) => spawner.string(ChildProcess.make("wc", ["-l", "notes.txt"], { cwd: "/tmp" }))
).pipe(Effect.provide(BrowserServices.layer({ bash, fs: NodeFsPromises })))
```

The spawner stats `cwd` before it runs anything. For an absent path, assert
`NotFound` from `FileSystem.stat`. For an existing non-directory, assert
`BadArgument` from `ChildProcess.spawn`. In both cases, assert that the
interpreter was never called.

## Assert the rendered command line

The line the interpreter receives is
[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/)'s `CommandLine.render`, which is the same
renderer a `proc:spawn` grant is checked against. Assert against the renderer
rather than against a string literal, and a grant can never authorize a line
different from the one that runs:

```ts
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as ChildProcess from "effect/unstable/process/ChildProcess"

const command = ChildProcess.make("echo", ["a b", "it's"])

// Quoted only where a token needs it, so argv semantics survive: echo 'a b' 'it'\''s'
const line = CommandLine.render(command)
```

## Pin an error tag with a throwing backend

A real filesystem cannot be made to raise `EACCES` on demand, so error mapping
is the one place a double is the right tool. A backend whose every member
rejects with the same value pins which code becomes which `PlatformError` tag:

```ts
import { BrowserFileSystem } from "@smthrs/platform-browser"

const throwingFs = (cause: unknown): BrowserFileSystem.ZenFsPromisesLike => {
  const boom = async (): Promise<never> => {
    throw cause
  }
  return { open: boom, readFile: boom, writeFile: boom, mkdir: boom, readdir: boom, stat: boom, rm: boom }
}

const denied = BrowserFileSystem.make(throwingFs(Object.assign(new Error("EACCES: boom"), { code: "EACCES" })))
```

`lstat` and `realpath` are absent from that literal on purpose. Both members are
optional. Without `realpath`, `realPath` fails with a `PermissionDenied`
`PlatformError`. Omitting both exercises the 128-level ceiling on a recursive
`readDirectory`.

## Make the stub settle after an abort

`JustBashLike.exec` requires the returned promise to settle once `signal`
aborts, because the adapter holds its serialization permit until the promise
settles. A stub that ignores the signal reproduces the real stall, which is the
only way that requirement becomes observable in a test:

```ts
import { BrowserChildProcessSpawner } from "@smthrs/platform-browser"

const bash: BrowserChildProcessSpawner.JustBashLike = {
  exec: (_commandLine, options) =>
    new Promise((resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      setTimeout(() => resolve({ stdout: "done\n", stderr: "", exitCode: 0 }), 10)
    })
}
```

A stub that rejects synchronously inside its own abort listener settles in the
same turn the permit is released, so an overlap can never be observed through
it. Count the calls in flight if the assertion is about concurrency.

## Choose layer or make

`BrowserFileSystem.layer(fs)` attests whole-filesystem isolation to
[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/); `BrowserFileSystem.make(fs)` builds the same
service without the claim. Passing `node:fs/promises` to `layer` is a test-time
convenience for a process that is itself the sandbox, and never a production
composition. When a test wants Effect's `FileSystem` with no kernel claim
attached, use `make`. See
[The isolation attestation](/concepts/isolation-attestation/).

## Where to stop

Test your own code's use of these services, not the adapters underneath them.
Everything these pages state as behaviour is fixed by the package: the options
each filesystem operation honours, which backend error becomes which
`PlatformError` tag, the fifteen operations that refuse, the rendered command
line, and the one-run-at-a-time abort boundary. A test that re-asserts one of
those is testing this package rather than your program.

## Related reading

- [Injected backends](/concepts/injected-backends/): the two slices, and what
  degrades when one omits an optional member.
- [Troubleshooting](/troubleshooting/): the failures a stub can reproduce,
  with the cause and the fix for each.
