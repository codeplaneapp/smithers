---
title: "Installation"
description: "Install @smthrs/capability, its runtime requirement, its import forms, and the enforcement it deliberately leaves to @smthrs/kernel."
sidebar:
  order: 1
---

## Install the package

```bash
pnpm add @smthrs/capability
```

The package requires Node.js 22.19.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. It has one runtime dependency,
[`effect`](https://effect.website), which supplies the `Schema`, `Option`, and
`PlatformError` types on its exported surface.

## Import forms

The root entry point re-exports both modules as namespaces:

```ts
import { Capability, Permission } from "@smthrs/capability"
```

Each module is also importable from its own subpath, which is the form host
adapters in this repository use:

```ts
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
```

Two subpath forms are not public: `@smthrs/capability/internal/*` and
`@smthrs/capability/*/index`. Both are blocked in the package's export map.
`@smthrs/capability/package.json` is exported.

## Test a value with the refinement, not `instanceof`

Because the package ships dual CommonJS and ESM, a consumer can load two copies
of it, and class identity is not stable across them. Use
`Permission.isPermissionError` to recognize a permission failure at a boundary.
It validates the whole enumerable shape rather than the `_tag` alone, so it
accepts a structurally valid failure from another copy of the package and
rejects a forgery that carries an extra field.

## What this package does not ship

There is no grant store, no decorated `FileSystem`, no journal, and no policy
loader here. This package answers "what was asked for, does a rule cover it,
and what does retrying it cost". Acting on the answer belongs to the packages
that hold state:

- [`@smthrs/kernel`](/api/kernel) owns the `GrantStore`, the layers that
  decorate host services, and the grant journal.
- [`@smthrs/agent`](/api/agent) declares a run's capability envelope and gates
  each call before its durable boundary opens.
- [`@smthrs/jj`](/api/jj) is one protected service that names
  `Permission.PermissionError` in its own error channel.

## Next step

Decide one request against a policy in the [Quickstart](./quickstart.md).
