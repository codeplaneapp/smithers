---
title: "Installation"
description: "Add @smthrs/scorers as a workspace dependency, meet its runtime requirements, and learn its import forms and the packages a persistent composition adds."
sidebar:
  order: 1
---

## Add the dependency

`@smthrs/scorers` is workspace-private at `0.1.0`, versioned independently of
the published `1.0.0-rc.0` packages, and is not published to npm. Depend on it
from another package in this repository with the workspace protocol:

```json
{
  "dependencies": {
    "@smthrs/scorers": "workspace:*"
  }
}
```

[`@smthrs/evals`](/api/evals) is the one consumer in the tree, and its
`package.json` is the working example of this declaration.

## Requirements

- Node.js 22.19.0 or later.
- [`effect`](https://effect.website) 4.0.0-rc.108, the version the workspace
  pins. Every public function returns an `Effect`, and every schema is an
  `effect/Schema`.
- [`@smthrs/core`](/api/core) for `Flow` and `Digest`. A scorer is a flow
  declaration, and the canonical JSON that derives a `scorerKey` comes from
  `Digest`.
- [`@smthrs/database`](/api/database) for the durable store. Only
  `SqlScoreStore` needs it: a composition that binds `ScoreStore.layerNoop`
  never touches a database.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Binding, Runner, RunnerLive, Sampling, Scorer, ScoreStore, SqlScoreStore } from "@smthrs/scorers"
```

Each top-level module is also importable from its own subpath, which is the
form [`@smthrs/evals`](/api/evals) uses:

```ts
import * as Sampling from "@smthrs/scorers/Sampling"
import * as Scorer from "@smthrs/scorers/Scorer"
```

Three subpath families are blocked in the export map, in development and in the
published build alike: `@smthrs/scorers/internal/*`,
`@smthrs/scorers/migrations/*`, and `@smthrs/scorers/*/index`. The migration
steps are implementation detail, so the aggregator is reachable only as the
root `Migrations` namespace. Importing a blocked subpath fails with Node's
`ERR_PACKAGE_PATH_NOT_EXPORTED`, which `test/Exports.test.ts` pins under both
`import` and `require`. `@smthrs/scorers/package.json` is exported.

## What a persistent composition adds

`SqlScoreStore.layer` needs a SQL client and a durable writer, both from
[`@smthrs/database`](/api/database). In production that is the Node SQLite
driver over a file:

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { SqlScoreStore } from "@smthrs/scorers"
import { Layer } from "effect"

const store = SqlScoreStore.layer.pipe(
  Layer.provide(DurableWriter.layer()),
  Layer.provide(NodeDatabase.layer({ filename: "smithers.db" }))
)
```

`NodeDatabase.layer` runs the durable engine on Node.js only: under Bun it
refuses to open with `unsupported_runtime`. For a test or a walkthrough,
`TestDatabase.layer` composes the same driver and writer over a fresh
`:memory:` database in one layer, and the [Quickstart](./quickstart.md) uses
it.

Building the store applies this package's four migrations to whatever database
it is pointed at, so no separate migration step is required. To apply them
without building a store, use `Migrations.layer`.

## Next step

Score two executions, persist them, and read the aggregate back in the
[Quickstart](./quickstart.md).
