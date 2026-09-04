---
title: "Installation"
description: "Install @smthrs/testing, its optional vitest peers, its import forms, and the subpaths that are deliberately not on the root barrel."
sidebar:
  order: 1
---

## Install the package

```bash
pnpm add -D @smthrs/testing
```

The package requires Node.js 22.19.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. Its runtime dependencies install with
it, including [`effect`](https://effect.website) and the `@smthrs/*` packages
the assertions read: [`@smthrs/core`](/api/core), [`@smthrs/engine`](/api/engine),
[`@smthrs/flow`](/api/flow), [`@smthrs/jj`](/api/jj),
[`@smthrs/journal`](/api/journal), [`@smthrs/kernel`](/api/kernel),
[`@smthrs/model`](/api/model), and [`@smthrs/plan`](/api/plan).

## Install the vitest peers only if you use the adapter

`vitest` and `@effect/vitest` are optional peer dependencies. Only the
`Vitest` module imports them:

```bash
pnpm add -D vitest @effect/vitest
```

Every other module works under any runner, because an assertion is an ordinary
`Effect` and a conformance case is a plain value.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Conformance, EngineSubject, JournalAssertions, TestLayers } from "@smthrs/testing"
```

Each module is also importable from its own subpath, which is the form the
[API reference](./api.md) uses:

```ts
import * as JournalAssertions from "@smthrs/testing/JournalAssertions"
import * as TestLayers from "@smthrs/testing/TestLayers"
```

## Two modules stay off the root barrel

`Vitest` is ESM only and absent from the barrel on purpose. `vitest` refuses to
load through `require()`, so a barrel that re-exported it would break
`require("@smthrs/testing")` for every CommonJS consumer of the assertion
helpers:

```ts
import * as Vitest from "@smthrs/testing/Vitest"
```

`Faults` is absent for a different reason: it is not a double. It sends real
signals to real pids and moves the wall clock this process reads. Importing it
by subpath keeps that decision visible at the import site:

```ts
import { killProcess, waitForReparent } from "@smthrs/testing/Faults"
```

## What is not public

`@smthrs/testing/internal/*` and `@smthrs/testing/*/index` are blocked in the
package's export map. `@smthrs/testing/package.json` is exported.

## Next step

Certify an engine against the mandatory conformance suite in the
[Quickstart](./quickstart.md).
