---
title: "Installation"
description: "Install @smthrs/kernel, its runtime requirements, its public subpaths, and the platform and journal packages a working host composition adds."
sidebar:
  order: 1
---

## Install the package

```bash
pnpm add @smthrs/kernel
```

The package requires Node.js 22.19.0 or later and ships as ESM, CommonJS, and
TypeScript declarations. Its runtime dependencies install with it:
[`effect`](https://effect.website), [`@smthrs/capability`](/api/capability),
[`@smthrs/jj`](/api/jj), [`@smthrs/journal`](/api/journal), and
[`@smthrs/platform-browser`](/api/platform-browser).

The root entry point carries no Node built-ins. A package test bundles the
whole root dependency graph for the browser and asserts that no
`node:child_process`, `node:fs`, `node:path`, or `node:process` import
survives, so the kernel itself runs anywhere its host does.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Capability, CapabilitySet, GrantStore, HostServices, Permission, Workspace } from "@smthrs/kernel"
```

Each module is also importable from its own subpath, which is the form the
API reference uses:

```ts
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HostServices from "@smthrs/kernel/HostServices"
```

`Capability` and `Permission` are re-exports. Their modules live in
[`@smthrs/capability`](/api/capability), so their deep import paths are
`@smthrs/capability/Capability` and `@smthrs/capability/Permission`.

Two subpath shapes are blocked in the export map: `@smthrs/kernel/internal/*`
and `@smthrs/kernel/*/index`. `@smthrs/kernel/package.json` is exported.

## Test subpaths

Three subpaths ship for testing. They are published code, not dev-only files:

| Subpath                              | What it gives you                                                                                    | Platform |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------- |
| `@smthrs/kernel/test/TestGrantStore` | `layerAllow`, `layerDeny`, and `layerScripted` grant-store doubles.                                  | any      |
| `@smthrs/kernel/test/TestHost`       | The deterministic host bundle: in-memory filesystem, scripted interpreter, `TestClock`, seeded PRNG. | Node.js  |
| `@smthrs/kernel/test/contract`       | `runHostContract`, the shared behavioral contract every host bundle must satisfy.                    | Node.js  |

`test/TestHost` and `test/contract` are Node-only: `effect/testing`'s
`TestClock` reaches for `node:assert`, and the contract uses Node process and
temporary-directory fixtures.

`test/contract` registers Vitest cases, so importing it requires the declared
peers:

```bash
pnpm add -D @effect/vitest@4.0.0-rc.108 vitest@4.1.9
```

Both peers are optional. A consumer that imports only the kernel or
`test/TestGrantStore` needs neither. See [Testing](./testing.md) for what each
one covers.

## What a working host adds

The kernel holds no platform implementations. It decorates ports that
something else provides, so a composition that actually reaches a machine adds
a platform bundle:

```bash
pnpm add @smthrs/platform-node
```

- [`@smthrs/platform-node`](/api/platform-node) implements the five ports on
  Node, attaches the descriptor-relative filesystem executor the kernel
  requires, and ships the process reaper that retires orphaned records.
- [`@smthrs/platform-bun`](/api/platform-bun) and
  [`@smthrs/platform-browser`](/api/platform-browser) implement the same
  ports for Bun and for the browser.
- [`@smthrs/journal`](/api/journal) is already a dependency, but a host only
  needs a live `Journal` service when it uses `JournalGrantStore` or the
  durable `ProcessLedger`.

## Next step

Guard a host and watch a call get refused in the
[Quickstart](./quickstart.md).
