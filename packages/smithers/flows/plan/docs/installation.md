---
title: "Installation"
description: "Install @smthrs/plan, satisfy its peer requirements, and add the packages a persisting composition needs."
sidebar:
  order: 1
---

## Requirements

- Node.js 22.19.0 or later.
- `effect` 4.0.0-rc.108. The package's schemas, layers, and error classes are
  Effect values, so the version has to match the one your application uses.

## Install

```bash
pnpm add @smthrs/plan
```

That is enough to build node graphs, compile plans, and diff them. Compiling
asks for Effect's `Crypto` service, which a platform package supplies:

```bash
pnpm add @effect/platform-node
```

## What persistence adds

`PlanStore` writes to SQL. A composition that records plans also needs
[`@smthrs/database`](/api/database) for the SQLite client and the durable
writer:

```bash
pnpm add @smthrs/database @effect/platform-node
```

`@smthrs/crypto` and [`@smthrs/keys`](/api/keys) arrive as dependencies of this
package; you do not install them yourself unless you use them directly.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { FileSet, Node, Plan, PlanStore } from "@smthrs/plan"
```

Each module is also its own entry point, which is the form the repository's own
code uses because it keeps a bundle to what it reaches for:

```ts
import * as Node from "@smthrs/plan/Node"
import * as Plan from "@smthrs/plan/Plan"
```

Both forms resolve to the same values.

## What you cannot import

The ordered migration steps live under `src/internal/migrations`, and the
export map blocks that prefix. `@smthrs/plan/Migrations` is the only way to
reach them.

```ts
import * as Migrations from "@smthrs/plan/Migrations"
// Migrations.set is the namespaced set; the steps inside it are not addressable.
```

A step imported on its own would run outside the namespaced ordering that
[`@smthrs/database`](/api/database)'s migrator relies on to decide what has
already been applied. Node reports `ERR_PACKAGE_PATH_NOT_EXPORTED` for the
internal path and `ERR_MODULE_NOT_FOUND` for the path the steps once shipped
from, and the package's export suite pins both in a cold Node process.

## Browser support

The package is browser-safe: it resolves no `node:` built-in, and the
repository's `pnpm run browser` check bundles this entry point to prove it. Compiling, diffing, and
building node graphs all work in a browser. `PlanStore` needs a SQL client, so
persistence is where a platform choice enters.

## Next

[Quickstart](./quickstart.md) compiles a plan, records it, and reads it back.
