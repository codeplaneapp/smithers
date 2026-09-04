---
title: "Installation"
description: "Install @smthrs/harness, the runtimes it supports, the entry points its exports map publishes, and the effect version it pins."
sidebar:
  order: 1
---

## Requirements

- Node.js 22.19.0 or later for the Node runtime, matching the package's
  `engines` field.
- A browser runtime works unchanged: the QuickJS binding compiles the same
  single-file WebAssembly build on Node and in a browser.
- Cloudflare workerd works through the build-naming seam, because workerd
  runs no WebAssembly it did not compile itself. For the setup, see
  [Run on Cloudflare workerd](./guides/workerd.md).

## Install the package

```bash
pnpm add @smthrs/harness@next
```

The package publishes release candidates to the `next` dist-tag.

The package pins `effect` 4.0.0-rc.108 as a dependency. A project that imports
`effect` in its own code installs the same version, so the service tags and
schemas the package exports are the same class instances the project
constructs:

```bash
pnpm add effect@4.0.0-rc.108
```

## Entry points

The `exports` map publishes these subpaths:

| Import | What it is |
| --- | --- |
| `@smthrs/harness` | The root barrel: 26 namespaces, each re-exporting one module. |
| `@smthrs/harness/<Module>` | Any top-level module directly, for example `@smthrs/harness/CellTurn`. |
| `@smthrs/harness/QuickJSSandbox` | The QuickJS-WASM `Sandbox` binding. Deliberately not re-exported from the root, because it carries an embedded WebAssembly build; only hosts that want it import it. |
| `@smthrs/harness/package.json` | The package manifest. |

The `./internal/*` and `./*/index` subpaths map to `null` and do not resolve.
Nothing under `src/internal/` is public.

## The namespaces on the root

Every namespace on the root barrel is also importable from its own subpath.
The complete list, with what each one is for, is the
[module index](./api.md#module-index) of the API reference.

## Compose the rest of a host

`@smthrs/harness` is translation, not assembly. A running agent also needs a
durable engine behind `EngineLike`, a registry behind `CellCalls`, and a model
provider behind `EngineLike.sealStep`. The production composition of all three
lives in [`@smthrs/agent`](/api/agent). The request and event shapes the
sealed model step carries belong to [`@smthrs/model`](/api/model), and the
descriptor and registry contracts belong to
[`@smthrs/registry`](/api/registry); those pages document them.

To run a first cell against the QuickJS binding, continue to the
[Quickstart](./quickstart.md).
