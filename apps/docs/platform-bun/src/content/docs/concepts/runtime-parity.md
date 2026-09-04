---
title: "Runtime parity with Node"
description: "Why the Bun bundle contains no runtime detection, which modules Bun and Node genuinely share, where the two runtimes are not yet proven equivalent, and what that means for bundling and for tests."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-bun/docs/concepts/runtime-parity.md"
---

The Bun bundle contains no `typeof Bun !== "undefined"` check, no branch on
`process.versions.bun`, and no fallback path chosen at runtime. It used to: an
earlier version shipped a `BunShell` that picked between `Bun.spawn` and
`node:child_process`, and a `BunHttpTransport` that borrowed a `fetch`-backed
transport from the browser package. Both were deleted, and neither is coming
back. This page is why, and where the parity stops.

## Bun and Node run the same modules here

Three of the five slots are filled by code that is identical on both runtimes,
not merely equivalent:

- `@effect/platform-bun/BunChildProcessSpawner` is
  `@effect/platform-node-shared`'s spawner re-exported. Spawning a child is one
  module, so there is nothing for a detection branch to choose between.
- `@smthrs/jj/bun/BunJj` is `@smthrs/jj/node/NodeJj` re-exported, because Bun
  implements the child-process API the argv-safe jj adapter uses. The two share
  the same error classification and the same interruption finalizer by
  construction, not by agreement.
- The filesystem slot is `@smthrs/platform-node`'s `AtomicFileSystem.layer`
  itself, the same value [`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/) puts in
  its own slot.

`effect/Path` is runtime independent, and the network slot is Effect's
fetch-backed client, which both runtimes provide natively. So the whole bundle
is Bun-specific in exactly one way: which package it takes those modules from.

## Two consequences you can rely on

**The bundle runs unchanged under Node.** Nothing in it requires the Bun
runtime, so a program composed on `BunHost.layer` executes on Node 22.19.0 or
later as well. That is not a compatibility shim; it is what "the same modules"
means. The package declares both floors in `engines`.

**A behavior recorded on one runtime replays on the other.** Because the
spawner, the jj adapter, and the filesystem adapter are the same modules, a
failure classified on Bun classifies the same way on Node.

## Node-only in the browser-bundle sense

The same property that makes the bundle portable between Bun and Node is what
stops it reaching a browser. Falling back to the `@effect/platform-node`
adapters means resolving `node:` built-ins, so `@smthrs/platform-bun` sits on
the repository's `NODE_ONLY` list, pinned by `scripts/browser-check.mjs`
against the `node:fs` it is expected to resolve.

It runs on Bun and it runs on Node. What it does not do is bundle for a page.
That is [`@smthrs/platform-browser`](https://platform-browser.smithers.sh/reference/api/), which fills the
same five slots from browser primitives.

## Where the parity is not yet proven

Every test suite in this package executes under Node. The
`//packages/smithers/flows/platform-bun:bunTest` target re-runs the same files
through Bun's package runner (`bun x vitest`, with no `--bun`), but the
`vitest` bin that resolves to is pnpm's `/bin/sh` shim, and every branch of
that shim `exec`s `node`. So that lane is Node as well.

For most of the surface this costs nothing, because process spawning is
literally the same module on both runtimes and there is no Bun-only spawn path
left to fake. The filesystem is the exception worth naming: its no-follow
extension runs each guarded operation in a CPython 3 subprocess rather than
in-process, so whether that helper starts under the Bun runtime is a question
this repository does not yet answer. Executing the suite on the Bun runtime is
tracked work.

Read the package's conformance claims with that boundary in mind. They are
claims about the modules the bundle installs, verified on Node, and the modules
are the same ones Bun would load.
