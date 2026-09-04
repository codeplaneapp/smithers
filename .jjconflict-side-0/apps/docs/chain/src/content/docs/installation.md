---
title: "Installation"
description: "Install @smthrs/chain and the services a run needs."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/chain/docs/installation.md"
---

## Requirements

- Node.js 22.19.0 or later, from the package's `engines` field.
- [Effect](https://effect.website) 4.0.0-rc.108. The package depends on it
  directly, so installing the package brings it along; every code sample on
  this site imports `Effect` and `Layer` from `effect`.

## Install the package

```bash
pnpm add @smthrs/chain
```

At 1.0.0-rc.0 `@smthrs/chain` is private and not published to npm. Inside the
smithers monorepo, declare it as a workspace dependency instead:

```json
{
  "dependencies": {
    "@smthrs/chain": "workspace:*"
  }
}
```

## Import paths

The barrel export and the wildcard subpath reach the same modules, so these
two imports name the same namespace:

```ts
import { Catalog } from "@smthrs/chain"
import * as Catalog from "@smthrs/chain/Catalog"
```

`./internal/*` is null-mapped in the export map and carries no promise.

## The services a run needs

`Chain.run` requires four services in its environment, and picks up two
optional seams when they are mounted:

| Service                     | Layer you mount                                     | Required |
| --------------------------- | --------------------------------------------------- | -------- |
| `Journal.Journal`           | `Journal.layerMemory()` or an engine-backed journal | Yes      |
| `Catalog.Catalog`           | `Catalog.layer(entries)` or a composed catalog      | Yes      |
| `Author.Author`             | `ModelAuthor.layer(config)` over `Model.Model`      | Yes      |
| `ScriptRunner.ScriptRunner` | `QuickJsRunner.layer()` (production)                | Yes      |
| `Authorize.Authorize`       | `Authorize.layerRules(rules)`                       | Optional |
| `Steering.Steering`         | `Steering.layerMemory()` or a durable queue         | Optional |

Two layers in this table can fail while they are being built, before any run
starts: `QuickJsRunner.layer()` fails with a `ScriptFailure` whose code is
`runner_unavailable` when the QuickJS WebAssembly module cannot load, and a
catalog layer such as `SubChains.layer` dies at construction when the host's
entries shadow reserved names. For the failure taxonomy, see
[Troubleshooting](/troubleshooting/).

`ModelAuthor.layer(config)` needs `Model.Model` from the
[@smthrs/model package](https://model.smithers.sh/reference/api/). Provide the model layer UNDER the author
layer with `Layer.provide`, not beside it in `Layer.mergeAll`: siblings in one
`mergeAll` cannot satisfy each other. The
[Quickstart](/quickstart/) shows the full composition.
