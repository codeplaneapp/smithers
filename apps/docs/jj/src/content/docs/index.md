---
title: "@smthrs/jj"
description: "Jujutsu version control as a portable Effect host service: one small contract for snapshot, restore, diff, and workspace lanes, with CLI, Bun, and WebAssembly layers behind it."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/jj/docs/README.md"
---

`@smthrs/jj` is version control as a host capability. It defines one service,
`Jj`, whose methods are the operations that make a step reversible: snapshot the
working copy, restore it, diff two revisions, add and forget the workspaces
parallel agents run in, read status, find the repository root, and revert a
single change.

Smithers snapshots the working copy around every step. That makes jj host
access, not a tool a program happens to shell out to, so it goes through a layer
the way the filesystem and the clock do. A caller holds the contract; the host
decides whether jj is the native CLI, the CLI routed through a contained process
spawner, or jj-lib compiled to WebAssembly and running in a browser tab.

## The problem it solves

An orchestrator that runs untrusted work has to be able to undo it. Reaching for
`spawn("jj", ...)` inside a step buys the undo and loses everything else: the
child escapes the host's process ledger, the failure arrives as an untyped
`Error` that serializes to `{}` in a journal, and the same program cannot run
anywhere without a `jj` binary on `PATH`.

This package answers all three. Every failure is a `JjError` with a code from a
closed set, projected onto data that survives a journal round trip. Every layer
classifies the same failure onto the same code, so a run recorded against the
CLI replays against WebAssembly. The root entry point resolves no `node:`
built-in, so a page bundles the contract and provides whichever implementation
it has.

## Install

```bash
pnpm add @smthrs/jj
```

The Node and Bun layers need a `jj` executable on the host. For versions, the
binary override, and the browser asset, see [Installation](/installation/).

## The shortest real example

```ts
import { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const jj = yield* Jj
  const { changeId } = yield* jj.snapshot("before the step")
  return changeId
}).pipe(Effect.provide(NodeJj.layer))
```

The body never changes when the host does. Swap `NodeJj.layer` for
`BunJj.layer`, for `NodeJj.layerSpawner` under a contained spawner, or for
`BrowserJj.layer({ fs, wasm })` in a page, and the program above is untouched.

## Entry points

The root is platform neutral and browser bundleable: the contract, its error,
and the no-op layer only. Every implementation lives under an explicit subpath,
the way `effect` keeps `@effect/platform-node` out of `effect`. `package.json`
maps `./*` onto `src/`, so every module below is public.

| Import                            | Platform                                                       |
| --------------------------------- | -------------------------------------------------------------- |
| `@smthrs/jj`                      | Any host. Contract only, and it bundles for the browser.       |
| `@smthrs/jj/node/NodeJj`          | Node, through `node:child_process` or a host spawner.          |
| `@smthrs/jj/node/resolveJjBinary` | Node. Which `jj` file this host spawns, and why.               |
| `@smthrs/jj/bun/BunJj`            | Bun, reusing the Node adapter.                                 |
| `@smthrs/jj/browser/BrowserJj`    | Browser. jj-lib compiled to wasm over a virtual filesystem.    |
| `@smthrs/jj/browser/WasiPreview1` | Browser. The WASI preview 1 shim that module runs on.          |
| `@smthrs/jj/browser/WasiFs`       | Browser. The synchronous filesystem surface the shim needs.    |
| `@smthrs/jj/wasm/flows_jj.wasm`   | The compiled reactor `BrowserJj` runs. An asset, not a module. |

`pnpm run browser` at the repository root pins that table: it asserts that the
first row and `BrowserJj` bundle for a browser, and that `NodeJj` and `BunJj`
still do not, because of `node:child_process`.

## Who uses this package

[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/) decorates the same `Jj` tag with capability
checks, so a host composition guards every jj operation behind a grant.
[`@smthrs/time-travel`](https://time-travel.smithers.sh/reference/api/) calls `snapshot`, `restore`, and
`workspaceAdd` to fork a run into a lane and rewind it.
[`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/) and
[`@smthrs/platform-bun`](https://platform-bun.smithers.sh/reference/api/) pick the layer that matches their
containment posture, and [`@smthrs/platform-browser`](https://platform-browser.smithers.sh/reference/api/)
wires `BrowserJj` over the page's mount.

## Where to go next

- [Installation](/installation/): the `jj` binary, the Node version, the
  import forms, and the wasm asset.
- [Quickstart](/quickstart/): snapshot a real repository, diff it, and put it
  back, in one file.
- Concepts: [version control as a capability](/concepts/version-control-as-a-capability/)
  and [how a jj failure is reported](/concepts/failures/).
- Guides: [snapshot and restore](/guides/snapshot-and-restore/),
  [workspace lanes](/guides/workspace-lanes/),
  [binding and containing the child process](/guides/bind-and-contain/),
  [choosing the jj binary](/guides/choose-the-jj-binary/),
  [running jj in a browser](/guides/run-jj-in-a-browser/), and
  [testing against Jj](/guides/testing/).
- [API reference](/reference/api/): every export, with signatures.
- [Troubleshooting](/troubleshooting/): each failure code, its cause, and
  what to change.
