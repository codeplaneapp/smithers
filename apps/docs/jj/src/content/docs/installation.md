---
title: "Installation"
description: "Install @smthrs/jj, the jj executable the Node and Bun layers spawn, the import forms for each entry point, and the wasm asset a browser layer needs."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/jj/docs/installation.md"
---

## Install the package

```bash
pnpm add @smthrs/jj
```

The package requires Node.js 22.19.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. It has two runtime dependencies:
[`effect`](https://effect.website) and
[`@smthrs/capability`](https://capability.smithers.sh/reference/api/), the leaf that names the permission
failures a guarded `Jj` adds to the error channel. Neither pulls in a process
spawner or an HTTP client, which is what keeps the root entry point
browser bundleable.

## Install jj for the Node and Bun layers

`NodeJj` and `BunJj` spawn the `jj` executable. This package vendors no
binaries, so install jj yourself:

```bash
brew install jj          # macOS
cargo install --locked jj-cli
```

Other platforms are covered by the
[Jujutsu installation guide](https://jj-vcs.github.io). Confirm the result:

```bash
jj --version
```

With no usable jj, every operation fails with the `not_installed` code and a
message naming the fix, rather than throwing. Nothing in the package installs,
downloads, or `chmod`s a binary on your behalf.

### Point at a specific jj

Set `SMITHERS_JJ_PATH` to the file you want spawned:

```bash
export SMITHERS_JJ_PATH=/opt/homebrew/bin/jj
```

An override that names an existing file stays authoritative even when it is not
executable, so a broken explicit path is reported instead of a different binary
being quietly substituted. An override that names nothing falls through to
`PATH`, and the fall-through is reported rather than silent. For the resolution
order and what `smthrs doctor` prints, see
[Choose which jj binary runs](/guides/choose-the-jj-binary/).

## Import forms

The root entry point re-exports the contract flat:

```ts
import { isJjError, Jj, JjError, layerNoop, make, makeNoop } from "@smthrs/jj"
```

Implementations are never root exports. Import each from its own subpath:

```ts
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import * as BunJj from "@smthrs/jj/bun/BunJj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as resolveJjBinary from "@smthrs/jj/node/resolveJjBinary"
```

Two subpath forms are not public and are blocked in the export map:
`@smthrs/jj/internal/*` and `@smthrs/jj/*/index`. `@smthrs/jj/package.json` is
exported.

## The wasm asset for a browser layer

`BrowserJj` runs a compiled reactor that ships in the package at
`wasm/flows_jj.wasm`, exported as `@smthrs/jj/wasm/flows_jj.wasm`. It is an
asset, not a module: the layer never fetches, so serving the bytes is your
bundler's business. Copy the file into your static assets or let the bundler
emit a URL for it, then compile it yourself and hand over the module:

```ts
const wasm = await WebAssembly.compileStreaming(fetch(wasmUrl))
```

`BrowserJj` accepts either a compiled `WebAssembly.Module` or the raw bytes, so
`fetch(wasmUrl).then((r) => r.arrayBuffer())` works too.

A browser layer also needs a synchronous filesystem, which the package does not
supply either. In a page that is ZenFS:

```bash
pnpm add @zenfs/core @zenfs/dom
```

See [Run jj in a browser tab](/guides/run-jj-in-a-browser/) for the whole
composition, and for rebuilding the wasm artifact from `crates/flows-jj`.

## What a host composition adds

A host that guards jj behind capability grants adds
[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/), whose `Jj.layer` decorates this package's tag
in place. A host that wants jj children inside its process ledger adds a
`ChildProcessSpawner` and uses `NodeJj.layerSpawner`;
[`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/) and
[`@smthrs/platform-bun`](https://platform-bun.smithers.sh/reference/api/) ship that composition already
wired.

## Next step

Take a snapshot of a real repository and put it back in the
[Quickstart](/quickstart/).
