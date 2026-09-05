---
title: "Runtime parity with Node"
description: "Why the Bun bundle contains no runtime detection, which modules Bun and Node genuinely share, what that buys a program that composes it, and where the parity stops."
sidebar:
  order: 2
---

The Bun bundle contains no `typeof Bun !== "undefined"` check, no branch on
`process.versions.bun`, and no fallback path chosen at runtime. It needs none:
the modules it puts in the slots are the modules Node runs. This page is why,
and where the parity stops.

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
  itself, the same value [`@smthrs/platform-node`](/api/platform-node) puts in
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
adapters means resolving `node:` built-ins, so a browser bundler asked to
resolve `@smthrs/platform-bun` stops at `node:fs`. That is the intended
resolution, not a packaging defect to work around with an alias.

It runs on Bun and it runs on Node. What it does not do is bundle for a page.
That is [`@smthrs/platform-browser`](/api/platform-browser), which fills the
same five slots from browser primitives.

## Where the parity stops

The bundle's conformance is verified on Node. Because the spawner, the jj
adapter, and the filesystem adapter are the same modules on both runtimes, that
is a claim about the modules Bun loads too, and not one about a Node-only
build.

The filesystem is the exception worth holding on to. Its no-follow extension
does not run in-process: it executes each guarded operation in a CPython 3
subprocess, so the slot depends on an interpreter the host provides rather than
on anything either runtime ships. Confirm `/usr/bin/python3` at startup rather
than discovering it at the first guarded write. See
[Run where python3 is not at /usr/bin/python3](../guides/configure-the-filesystem-helper.md).
