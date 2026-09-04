---
title: "@smthrs/platform-node"
description: "The Node.js Host bundle for Smithers: Effect's Node platform services composed into the closed five-tag Host surface, plus the descriptor-relative filesystem, the process reaper, and the liveness probe Node needs and Effect does not ship."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-node/docs/README.md"
---

`@smthrs/platform-node` is the Node implementation of the Smithers Host: one
layer that provides every host capability a durable flow can reach.

The Host surface is a closed set of five service tags. Three of them are
Effect's own, and two are Smithers':

| Tag                   | Where the tag lives                           | What provides it here                   |
| --------------------- | --------------------------------------------- | --------------------------------------- |
| `FileSystem`          | `effect/FileSystem`                           | `AtomicFileSystem`, this package        |
| `Path`                | `effect/Path`                                 | Effect's `Path.layer`                   |
| `ChildProcessSpawner` | `effect/unstable/process/ChildProcessSpawner` | `@effect/platform-node`'s Node spawner  |
| `Jj`                  | [`@smthrs/jj`](https://jj.smithers.sh/reference/api/)                       | that package's `NodeJj`                 |
| `HttpClient`          | `effect/unstable/http/HttpClient`             | `@effect/platform-node`'s Undici client |

A program written against those tags runs on any bundle that provides them.
[`@smthrs/platform-bun`](https://platform-bun.smithers.sh/reference/api/) and
[`@smthrs/platform-browser`](https://platform-browser.smithers.sh/reference/api/) are the sibling bundles,
and [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/) owns the tag list and decorates every one
of them with a capability check.

## Install

```bash
pnpm add @smthrs/platform-node @effect/platform-node effect
```

The bundle needs a POSIX host with CPython 3 at `/usr/bin/python3`. For why,
and for what a host without it does, see [Installation](/installation/).

## The smallest real program

```ts
import { NodeHost } from "@smthrs/platform-node"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("printf", ["hello"]))
})

await Effect.runPromise(Effect.provide(program, NodeHost.layer))
```

## What this package composes, and what it implements

Most of the bundle is composition. `@effect/platform-node` already ships a
filesystem, a child-process spawner, and an Undici-backed `HttpClient`;
`NodeHost.layer` merges them with Effect's `Path` and the Node `Jj` adapter
from [`@smthrs/jj`](https://jj.smithers.sh/reference/api/).

Three modules are implementation, because the guarantees Smithers makes about
a host are not ones Effect's adapters make on their own:

| Module             | What it is                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AtomicFileSystem` | The filesystem slot. Every operation runs relative to a pinned directory descriptor, so a symlink swapped in after authorization cannot redirect it. |
| `ProcessReaper`    | The sweep that kills process groups a crashed incarnation of this host abandoned.                                                                    |
| `HostLiveness`     | Whether a recorded run owner is still running here, which is what the engine steals runs on.                                                         |

`NodeHost` is the fourth module: the aggregate that puts the five tags in one
layer, in four variants.

| Layer                                       | `Jj` bound to                | Process containment |
| ------------------------------------------- | ---------------------------- | ------------------- |
| `NodeHost.layer`                            | the process directory        | no                  |
| `NodeHost.layerAt(root)`                    | one absolute repository root | no                  |
| `NodeHost.layerContained(options?)`         | the process directory        | yes                 |
| `NodeHost.layerContainedAt(root, options?)` | one absolute repository root | yes                 |

## What this bundle refuses

The refusals are the design, not gaps to fill later:

- **No shell service.** Running a command is Effect's `ChildProcess` and
  `ChildProcessSpawner`. A wall-clock budget is `Effect.timeout` around the
  effect, and cancellation is fiber interruption, never an `AbortSignal`.
- **No HTTP wrapper.** An outgoing request is Effect's `HttpClient`, provided
  as `NodeHttpClient.layerUndici`. Undici installs no redirect interceptor, so
  every hop stays a separate request the kernel can check.
- **No Windows.** `AtomicFileSystem` has none of the POSIX primitives it needs
  there and fails every operation closed. Reaping on Windows is unsupported
  best-effort.
- **No path-based fallback.** A host with no usable CPython 3 fails every
  guarded filesystem call with `PermissionDenied` rather than reverting to a
  check-then-path operation.
- **No filesystem operation that cannot be one descriptor-relative request.**
  `open`, `stream`, `sink`, `watch`, `copy`, `link`, `symlink`, `chmod`, and
  the `makeTemp*` family fail closed under the kernel decorator.

## Where to go next

- [Installation](/installation/): requirements, peer dependencies, entry
  points, and the packages a real composition adds.
- [Quickstart](/quickstart/): stand up a host, run a command, and watch the
  confinement refuse a symlink escape.
- Concepts: [the host bundle](/concepts/host-bundle/),
  [the descriptor-relative filesystem](/concepts/descriptor-relative-filesystem/),
  and [process containment](/concepts/process-containment/).
- Guides: [contain child processes](/guides/contain-child-processes/),
  [configure the filesystem helper](/guides/configure-the-filesystem-helper/),
  [match files with a glob pattern](/guides/match-files-with-glob/), and
  [answer whether a run owner is alive](/guides/answer-run-ownership/).
- [API reference](/reference/api/): every export, with signatures and defaults.
- [Troubleshooting](/troubleshooting/): the failures this bundle reports,
  what causes them, and what to change.
