---
title: "@smthrs/platform-bun"
description: "The Bun Host bundle for Smithers: Effect's Bun platform services composed with the jj adapter and the atomic filesystem into the closed five-slot Host surface, with optional process containment."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-bun/docs/README.md"
---

`@smthrs/platform-bun` is the Bun implementation of the Smithers Host surface.
A Smithers program reaches the outside world through exactly five Effect
service tags: `FileSystem`, `Path`, `ChildProcessSpawner`, `Jj`, and
`HttpClient`. This package fills all five for Bun, and `BunHost.layer` is the
single layer that provides them.

## The problem it solves

The closed Host list is what makes a program both portable and governable. A
step written against the five tags runs on any bundle that provides them, and
[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/) decorates those same tags in place with
capability checks, so a consumer that never heard of the kernel still cannot
get around it. A program that reaches for `Bun.spawn` or a bare `fetch` leaves
that surface: nothing can attenuate it, deny it, or record it.

Filling the slots on Bun is mostly a composition problem, not an
implementation problem. `@effect/platform-bun` already ships a child-process
spawner and a fetch-backed `HttpClient`, and its spawner is
`@effect/platform-node-shared`'s re-exported unchanged. So this package writes
no spawner, no HTTP client, and no runtime detection. It composes what exists
into one closed surface and adds the two things Bun has no answer for: the
`Jj` adapter from [`@smthrs/jj`](https://jj.smithers.sh/reference/api/), and the descriptor-relative atomic
filesystem from [`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/).

## Install

```bash
pnpm add @smthrs/platform-bun @effect/platform-bun@4.0.0-rc.108
```

`@effect/platform-bun` is an optional peer dependency, so your package manager
does not install it for you and the root import fails without it. The
filesystem slot also needs a CPython 3 interpreter on the host. For both, see
[Installation](/installation/).

## The shortest real example

```ts
import { BunHost } from "@smthrs/platform-bun"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("git", ["status", "--short"]))
})

Effect.runPromise(Effect.provide(program, BunHost.layer))
```

Nothing in the body names Bun. Provide
[`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/)'s `NodeHost.layer` instead and
the program is untouched.

## What fills each slot

`BunHost.implementationIds` is this table as data, keyed by the kernel's
closed slot ids, so a swapped implementation is a visible change rather than a
comment that drifted:

| Slot                                 | Implementation                                | Whose code it is                            |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------- |
| `effect/FileSystem`                  | `@smthrs/platform-node/AtomicFileSystem`      | Smithers, shared byte for byte with Node    |
| `effect/Path`                        | `effect/Path`                                 | Effect, runtime independent                 |
| `effect/process/ChildProcessSpawner` | `@effect/platform-bun/BunChildProcessSpawner` | Effect, re-exported from the Node spawner   |
| `@smthrs/jj/Jj`                      | `@smthrs/jj/bun/BunJj`                        | Smithers, re-exported from the Node adapter |
| `effect/HttpClient`                  | `@effect/platform-bun/BunHttpClient`          | Effect, fetch backed                        |

[The Host surface on Bun](/concepts/host-surface/) explains what each slot
buys and how to take one service without the other four.

## What this bundle refuses

- **No shell service, and no runtime detection.** Running a command is
  Effect's `ChildProcessSpawner`. Bun's spawner is the Node one, so there is
  nothing to detect between them.
- **No HTTP wrapper, and no redirect following.** The bundle provides Effect's
  fetch-backed client configured with `RequestInit { redirect: "manual" }`, so
  the runtime never walks to a second origin behind the capability kernel's
  back. Following a redirect is the kernel's guarded `HttpClient.layer`, which
  rechecks every hop.
- **No relative repository root.** `BunHost.layerAt` and
  `BunHost.layerContainedAt` throw `BunHost.BunHostError` with code
  `invalid_repository_root` when the root is not absolute, the empty string
  included.
- **No caller-supplied `platform` under containment.** The spawner decides
  process grouping from the real `process.platform`, so accepting a claim
  about it could only teach the ledger a durable lie.
- **No browser bundle.** The bundle falls back to the `@effect/platform-node`
  adapters off Bun and so resolves `node:` built-ins. It runs on Bun and on
  Node; what it does not do is bundle for a page. That is
  [`@smthrs/platform-browser`](https://platform-browser.smithers.sh/reference/api/).
- **No `BunJj` re-export.** The `Jj` adapter belongs to
  [`@smthrs/jj`](https://jj.smithers.sh/reference/api/) and is imported from there.

## Modules

The root entry point re-exports both modules as namespaces, and each is also
importable from `@smthrs/platform-bun/<Module>`:

| Namespace       | What it provides                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BunHost`       | The closed Host bundle: `layer`, `layerAt`, `layerContained`, `layerContainedAt`, the `BunHostError` the two root-bound factories throw, and `implementationIds`. It re-exports the four single-slot modules. |
| `BunFileSystem` | The filesystem slot on its own, plus `layerWith` for a host whose python3 is not at `/usr/bin/python3`.                                                                                                       |

Every export, with its signature and its failure behavior, is on the
[API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): the peer dependency, the CPython 3
  prerequisite, the import forms, and what a guarded composition adds.
- [Quickstart](/quickstart/): run a command and a file operation through
  the host, then turn containment on and watch a child enter the ledger.
- Concepts: [the Host surface on Bun](/concepts/host-surface/) and
  [runtime parity with Node](/concepts/runtime-parity/).
- Guides: [bind the host to a repository root](/guides/bind-a-repository-root/),
  [contain and reap child processes](/guides/contain-child-processes/), and
  [run where python3 is not at /usr/bin/python3](/guides/configure-the-filesystem-helper/).
- [Troubleshooting](/troubleshooting/): the failures this bundle produces,
  what causes each one, and what to change.
