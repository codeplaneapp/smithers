---
title: "Run on Cloudflare workerd"
description: "How to run harness cells inside Cloudflare's workerd by naming the QuickJS build through the Variant seam, and how to prove it with the shipped worker smoke."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/harness/docs/guides/workerd.md"
---

`QuickJSSandbox.make` and `QuickJSSandbox.layer` compile the single-file
QuickJS build from bytes, which is what Node and a browser want. Cloudflare's
workerd runs no WebAssembly it did not compile itself: `WebAssembly.compile`
over bytes fails at runtime, and the only module a worker can instantiate is
one its toolchain bundled and handed over as an import. `QuickJSSandbox.Variant`
is the seam for that host.

## Name the build

A worker names its build with the `.wasm` module its bundler compiled:

```ts
import wasmfile from "@jitl/quickjs-wasmfile-release-sync"
import wasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm"
import { Layer } from "effect"
import type { QuickJSSyncVariant } from "quickjs-emscripten-core"
import { newVariant } from "quickjs-emscripten-core"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"

const base = wasmfile as unknown as QuickJSSyncVariant

const layer = QuickJSSandbox.layerWithVariant.pipe(
  Layer.provide(QuickJSSandbox.layerVariant(newVariant(base, { wasmModule })))
)
```

The pieces:

- `@jitl/quickjs-wasmfile-release-sync` is the separate-file build, whose
  emscripten glue carries a `workerd` export condition. Its published types
  name the CommonJS declaration, so TypeScript models the import as
  `module.exports` while bundlers resolve the ESM variant; the assertion
  states the shape the runtime delivers.
- `@jitl/quickjs-wasmfile-release-sync/wasm` is the `.wasm` file as a module
  import, which is how wrangler hands a worker a compiled
  `WebAssembly.Module`.
- `newVariant(base, { wasmModule })` builds the variant. It only records the
  module; nothing instantiates until the sandbox compiles it, so module scope
  stays free of the work workerd forbids there.
- `QuickJSSandbox.layerVariant(variant)` provides the named build, and
  `layerWithVariant` is the sandbox over whichever build is in context.

The compiled module is cached per variant, so two sandboxes over one variant
share it. `QuickJSSandbox.layerVariantLive` provides the single-file default,
and `makeWithVariant` is the effectful constructor over the same seam.

Under Node, `test/QuickJSVariant.test.ts` exercises the same path by reading
and compiling the `.wasm` file itself in place of the bundler, and pinning
`wasmLocation` to a path that does not exist so a passing cell can only have
run against the named module.

## Run one cell in a worker

The repository ships a wrangler project at `test/workerd/` that imports the
sandbox, names the bundled `.wasm` module, and runs one cell in its `fetch`
handler. The worker is the example above plus an evaluation:

```ts
const cell = `const files = await ctx.call("fs/list", { path: "." })
ctx.done(files.join(","))`
```

The project is not a pnpm workspace member, because wrangler ships the
workerd binary and nothing else in the repository needs it. Run the smoke:

```bash
cd packages/smithers/agent/harness/test/workerd
npm install
node smoke.mjs
```

`smoke.mjs` starts `wrangler dev`, waits for the worker, and fails unless the
cell completed. `npm run dev` serves the same worker on
`http://127.0.0.1:8799` for hand inspection.

## Run the smoke from the test suite

The smoke is not part of the default `pnpm --filter @smthrs/harness run test`:
it needs a separate install and a downloaded runtime, so
`test/WorkerdSmoke.test.ts` skips unless `FLOWS_WORKERD_SMOKE=1` is set:

```bash
FLOWS_WORKERD_SMOKE=1 pnpm --filter @smthrs/harness run test
```

`FLOWS_WORKERD_PORT` and `FLOWS_WORKERD_STARTUP_MS` override the port (8799)
and the readiness deadline (120,000 ms).

## What a failure here means

A worker that compiles the default single-file build dies at startup with the
runtime's refusal of `WebAssembly.compile` over bytes, which the sandbox
reports as a `SandboxError` of code `runtime_failed`. That failure means the
host named no build; the fix is the variant wiring above, not a limits
change. For the error taxonomy, see
[Troubleshooting](/troubleshooting/).
