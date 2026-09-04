---
title: "@smthrs/platform-browser"
description: "The two Effect platform services a browser tab does not get for free: a FileSystem over a mounted ZenFS volume and a ChildProcessSpawner over an in-page bash interpreter, plus the closed BrowserHost bundle."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-browser/docs/README.md"
---

`@smthrs/platform-browser` supplies the two platform services
`@effect/platform-browser` does not ship.

Effect's own browser platform package covers HTTP, sockets, workers, key-value
storage, and crypto. It ships neither a `FileSystem` nor a
`ChildProcessSpawner`, because a browser tab has no `node:fs` and cannot fork a
process. A tab can have both anyway, given a virtual filesystem (ZenFS) and an
in-page bash interpreter (just-bash). This package is that adapter pair,
written the way [`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/) writes its own,
plus `BrowserHost`: the complete closed Host bundle Smithers runs on.

## Who uses this package

A tab can run the memory engine, the platform adapters, and the capability
kernel. Compose `BrowserHost` for the five host services, `BrowserServices`
for filesystem/path/commands, or either adapter individually.

The durable engine does **not** run in a tab today. The shipped `SqlClient`
uses `node:sqlite`, and `NodeRuntime` is Node-only. Providing the five Host
services does not supply a browser database or make durable execution portable.

`BrowserHost` exposes only `layer`, with injected backends; it has no `layerAt`
or contained-host factories. Crypto is not bundled. Supply
`@effect/platform-browser/BrowserCrypto.layer` alongside it when using artifact
hashing. The artifact filesystem mode is `durability: "best-effort"` and
`coordination: "process"`; the mount must implement `rename` and `utimes`.

## Install

```bash
pnpm add @smthrs/platform-browser
```

Neither `@zenfs/core` nor `just-bash` is a dependency here. Both arrive as
structural slices, so the page decides which backend is mounted and which
interpreter is wired to it. For what you supply and where it comes from, see
[Installation](/installation/).

## The smallest real composition

```ts
import { BrowserChildProcessSpawner, BrowserFileSystem, BrowserServices } from "@smthrs/platform-browser"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

/** The page's own interpreter and its ZenFS promises API, on one mounted volume. */
declare const bash: BrowserChildProcessSpawner.JustBashLike
declare const fs: BrowserFileSystem.ZenFsPromisesLike

const program = Effect.flatMap(
  ChildProcessSpawner,
  (spawner) => spawner.string(ChildProcess.make("cat", ["notes.txt"], { cwd: "/workspace" }))
).pipe(Effect.provide(BrowserServices.layer({ bash, fs })))
```

`BrowserServices.layer` is a function, where `NodeServices.layer` is a value.
That is the whole design in one signature: the tab owns which volume is mounted
and which interpreter is wired to it, and the two must be the same filesystem or
the spawner and the `FileSystem` service disagree about what exists. See
[Injected backends](/concepts/injected-backends/).

For a runnable first success in a real page, see the
[Quickstart](/quickstart/).

## The package at a glance

The root entry point exports four namespaces, and each is also importable from
`@smthrs/platform-browser/<Module>`:

| Namespace                    | What it is                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `BrowserFileSystem`          | Effect's `FileSystem` over a ZenFS-shaped promises API, plus the structural slices that API must satisfy.             |
| `BrowserChildProcessSpawner` | Effect's `ChildProcessSpawner` over an in-page bash interpreter, plus the structural slice that interpreter provides. |
| `BrowserServices`            | The aggregate of `ChildProcessSpawner`, `FileSystem`, and `Path`, mirroring `NodeServices`.                           |
| `BrowserHost`                | The complete closed Host bundle: those three plus the wasm-backed `Jj` and Effect's fetch-backed `HttpClient`.        |

Every export, with signatures, is on the [API reference](/reference/api/).

## What a tab refuses

Both adapters are explicit about the gap between a tab and a machine, and every
refusal below is a typed `PlatformError` rather than a silent wrong answer:

- The spawner runs one command at a time, buffers its output, has no stdin, and
  rejects process pipelines, extra file descriptors, a named shell, a detached
  command, and `forceKillAfter`. See
  [Run a command in a tab](/guides/run-a-command/).
- The filesystem serves what a promises-shaped volume can serve. Symlink
  creation, writable handles, watchers, and the `makeTemp*` family fail with
  `PermissionDenied`. See
  [Read and write files on a mounted volume](/guides/work-with-files/).
- A redirect is never followed behind the capability kernel's back. In a tab it
  returns an opaque response with status 0, because Fetch hides redirect details. See
  [The closed Host surface](/concepts/host-bundle/).

## The sibling hosts

`BrowserHost` provides the same five service tags as
[`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/)'s `NodeHost` and
[`@smthrs/platform-bun`](https://platform-bun.smithers.sh/reference/api/)'s `BunHost`. Host-level programs can use those tags across all three. Durable execution
still requires the Node database and runtime described above.

## Where to go next

- [Installation](/installation/): what you supply, the import forms, and the
  browser bundle gate.
- [Quickstart](/quickstart/): mount a volume, run a command, and read the
  file back through both views.
- Concepts: [injected backends](/concepts/injected-backends/),
  [the isolation attestation](/concepts/isolation-attestation/), and
  [the closed Host surface](/concepts/host-bundle/).
- Guides: [compose the host bundle](/guides/compose-the-host/),
  [run a command in a tab](/guides/run-a-command/), and
  [read and write files](/guides/work-with-files/).
- [The browser host contract](/contract/): the normative statement of where
  this host diverges from `NodeHost`.
- [Testing](/testing/): satisfy both slices with ordinary objects, and what
  this package's own suite already pins.
- [Troubleshooting](/troubleshooting/): the refusals both adapters report,
  what causes each one, and what to change.
