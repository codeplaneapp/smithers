---
title: "Installation"
description: "Install @smthrs/testing, its optional vitest peers, its import forms, and the subpaths that are deliberately not on the root barrel."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/testing/docs/installation.md"
---

## Install the package

```bash
pnpm add -D @smthrs/testing@next effect@4.0.0-rc.112
```

The Smithers 1.0 release candidates publish under the `next` dist tag, so the
tag is required: the unqualified name still resolves to the 0.x line, whose API
these pages do not describe. The first candidate is not on npm yet; until it
is, build the package from a clone of
[the repository](https://github.com/smithersai/smithers).

[`effect`](https://effect.website) is a required peer dependency at exactly
`4.0.0-rc.112`. Two copies of `effect` in one program are two sets of service
tags, so the version is pinned rather than ranged.

The package requires Node.js 22.19.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. The `@smthrs/*` packages the assertions
read install with it: [`@smthrs/core`](https://core.smithers.sh/reference/api/),
[`@smthrs/engine`](https://engine.smithers.sh/reference/api/), [`@smthrs/flow`](https://flow.smithers.sh/reference/api/),
[`@smthrs/jj`](https://jj.smithers.sh/reference/api/), [`@smthrs/journal`](https://journal.smithers.sh/reference/api/),
[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/), [`@smthrs/model`](https://model.smithers.sh/reference/api/), and
[`@smthrs/plan`](https://plan.smithers.sh/reference/api/). The grading facade also installs
[`@smthrs/scorers`](https://scorers.smithers.sh/reference/api/), which owns the runner-neutral `ScoreGate`
implementation. Evals consumes scorers directly and needs no testing facade
in production.

## Install the vitest peers only if you use the adapter

`vitest` and `@effect/vitest` are optional peer dependencies. Only the
`Vitest` module imports them, and `@effect/vitest` is pinned the same way
`effect` is:

```bash
pnpm add -D vitest@4.1.9 @effect/vitest@4.0.0-rc.112
```

Every other module works under any runner, because an assertion is an ordinary
`Effect` and a conformance case is a plain value.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Conformance, EngineSubject, JournalAssertions, TestLayers } from "@smthrs/testing"
```

Each module is also importable from its own subpath, which is the form the
[API reference](/reference/api/) uses:

```ts
import * as JournalAssertions from "@smthrs/testing/JournalAssertions"
import * as TestLayers from "@smthrs/testing/TestLayers"
```

## Three modules stay off the root barrel

`TestHost` is the deterministic host bundle: an in-memory filesystem, scripted
interpreter, `TestClock`, and seeded PRNG. Import it explicitly:

```ts
import * as TestHost from "@smthrs/testing/TestHost"
```

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
[Quickstart](/quickstart/).
