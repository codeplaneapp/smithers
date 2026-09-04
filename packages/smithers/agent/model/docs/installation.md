---
title: "Installation"
description: "Install @smthrs/model, its runtime requirements, and its import forms."
sidebar:
  order: 1
---

Install the package with pnpm:

```bash
pnpm add @smthrs/model
```

## Requirements

The package requires Node.js 22.19.0 or later, and installs `effect`,
`@smthrs/capability`, and `@smthrs/kernel` as its own dependencies. Provider
requests run through the kernel's permission-aware HTTP client, which checks a
`model:call` capability for the target host and model before any bytes leave
the process. For that contract, see the [kernel API](/api/kernel).

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Model, ModelEvent, ModelRequest, Route } from "@smthrs/model"
```

Every namespace is also importable on its own subpath, which keeps type
resolution narrow in large projects:

```ts
import * as Route from "@smthrs/model/Route"
```

Two subpath forms are blocked on purpose: `@smthrs/model/internal/*` and any
nested `*/index`. `@smthrs/model/package.json` is exported for tooling that
needs the version.

## What installs alongside

A configured route executes through two services from the same dependency
closure: `RequestExecutor` from this package and the kernel `HttpClient` from
`@smthrs/kernel`. When you compose `Route.layer` yourself, you provide both;
the [quickstart](./quickstart.md) shows the full layer graph, and
[Handle failures](./guides/handle-failures.md) covers the permission errors
the kernel can raise alongside `ModelError`.
