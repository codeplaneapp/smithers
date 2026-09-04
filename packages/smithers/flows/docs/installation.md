---
title: "Installation"
description: "Install @smthrs/flows, its Node requirement, its three import forms, the platform package it deliberately leaves to you, and when to depend on individual engine packages instead."
sidebar:
  order: 1
---

## Install the package

```bash
pnpm add @smthrs/flows@next
```

The `next` tag is where the 1.0 release candidates publish. Installing the
barrel installs all nineteen engine packages it re-exports, plus
[`effect`](https://effect.website) and `esbuild`, which `SandboxedFlow` uses to
bundle a guest entry module.

Durable execution requires Node.js 22.19.0 or later with local SQLite, which is
what `package.json` declares in `engines`. The package ships as ESM and
CommonJS with TypeScript declarations.

## Import forms

The root entry point is the barrel. Authoring names are flat and infrastructure
packages are namespaces:

```ts
import { Action, Engine, Flow, Interpreter, Journal, Kernel } from "@smthrs/flows"
```

The two modules this package owns are subpaths, and they are Node-only:

```ts
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as SandboxedFlow from "@smthrs/flows/SandboxedFlow"
```

Two subpath forms are blocked in the export map and are not public:
`@smthrs/flows/internal/*` and `@smthrs/flows/*/index`.
`@smthrs/flows/package.json` is exported.

## Choose a platform package yourself

The barrel re-exports no `@smthrs/platform-*` bundle, for the same reason
`effect`'s own index does not re-export `@effect/platform-node`: a platform is
chosen by the program that runs, not by the library it depends on. Re-exporting
all three would make one import resolve `node:child_process`, ZenFS, and Bun at
once.

Add the one your program runs on:

```bash
pnpm add @smthrs/platform-node
```

- [`@smthrs/platform-node`](/api/platform-node) supplies the Node host,
  containment, process reaping, and the liveness probe.
  `NodeRuntime.layerHost` already builds on it, so a program that uses
  `layerHost` needs no platform import of its own.
- [`@smthrs/platform-bun`](/api/platform-bun) supplies the Bun host.
- [`@smthrs/platform-browser`](/api/platform-browser) supplies a browser host
  for authoring and inspection.

Test doubles are reached the same way, through their own packages:
`@smthrs/kernel/test/TestHost`, `@smthrs/database/node/NodeDatabase`,
`@smthrs/journal/test/TestJournal`.

## Bundling for a browser is not durable execution

The root entry point bundles for a browser, and the repository's browser gate
holds every re-exported package root to that. What bundles is the authoring and
inspection surface: you can declare flows, read a plan, and decode a journal
event in a browser.

Durable execution is a different claim, and it is Node-only in this release.
A browser or edge runtime is not a supported durable host even when you supply
another SQL client. Both Node-only modules are subpaths precisely so importing
the root never opens `node:sqlite`.

## When to depend on individual packages instead

The barrel is a convenience, not a seam. A library published to other consumers
usually wants the narrower dependency: depend on
[`@smthrs/flow`](/api/flow) alone to declare flows and actions, or on
[`@smthrs/engine`](/api/engine) and
[`@smthrs/engine-store`](/api/engine-store) to execute them. Reach for
`@smthrs/flows` in the program that composes the whole engine, which is where
one dependency saves you nineteen.

## Next step

Stand a durable runtime up and run a flow on it in the
[Quickstart](./quickstart.md).
