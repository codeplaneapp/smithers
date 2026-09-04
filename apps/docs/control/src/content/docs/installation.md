---
title: "Installation"
description: "Install @smthrs/control, its runtime requirements, its import forms, and the collaborator packages an in-memory, durable, or remote composition adds."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/installation.md"
---

## Install the package

```bash
pnpm add @smthrs/control
```

The package requires Node.js 22.19.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. Its runtime dependencies install with
it: [`effect`](https://effect.website) and the `@smthrs/*` packages the plane
composes.

Nothing in `src/` imports `node:*`. Identity comes from `globalThis.crypto`,
encryption comes from Web Crypto, and persistence speaks the driver-neutral SQL
contract, so the same modules run in Node and in a browser that supplies a SQL
driver. The 1.0.0-rc.0 support matrix still records `@smthrs/control` as
**no claim (no `node:` imports)**: it is not one of the entry points
`scripts/browser-check.mjs` bundles, so no gate proves it bundles. Read the
claim as what it is, an absence of `node:` imports rather than a tested
guarantee.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Control, ControlLive, Monitor, SqlControlRuntime } from "@smthrs/control"
```

Each module is also importable from its own subpath, which is the form the
[API reference](/reference/api/) uses:

```ts
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlSchema from "@smthrs/control/ControlSchema"
```

The deterministic test stack has its own subpath:

```ts
import * as TestControl from "@smthrs/control/test/TestControl"
```

Two subpath families are not public and are blocked in the export map:
`@smthrs/control/internal/*` and `@smthrs/control/migrations/*`, along with
every nested `*/index`. `@smthrs/control/package.json` is exported.

## What a composition adds

`ControlLive.layer` requires four collaborators, and a host provides all four:

| Requirement         | Package                                       | What it does here                                                                  |
| ------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ControlRuntime`    | this package                                  | Stores plans, tokens, grants, idempotency records, and run rows.                   |
| `Journal`           | [`@smthrs/journal`](https://journal.smithers.sh/reference/api/)             | Records every decision beside the state change it caused, and backs `watch`.       |
| `NotificationQueue` | [`@smthrs/notifications`](https://notifications.smithers.sh/reference/api/) | Carries a steer to the turn boundary that delivers it, and counts what is pending. |
| `Registry`          | [`@smthrs/registry`](https://registry.smithers.sh/reference/api/)           | Answers `list({ _tag: "flows" })` with the flows this host discovered.             |

`ControlExecutor` is optional. A composition that provides none observes and
records but starts nothing, which is the correct shape for a monitor or a
read-only dashboard.

### An in-memory composition

Nothing extra. `TestControl.layer` bundles all four collaborators with the
deterministic runtime, and it is what the [Quickstart](/quickstart/) uses.

### A durable composition

```bash
pnpm add @smthrs/database @smthrs/run-store
```

- [`@smthrs/database`](https://database.smithers.sh/reference/api/) supplies the SQL client and the
  `DurableWriter` every control write serializes through.
- [`@smthrs/run-store`](https://run-store.smithers.sh/reference/api/) supplies the fenced run store
  `SqlControlRuntime` maps the control lifecycle onto.

See [Store control state in a database](/guides/durable-storage/) for the
layer stack and the migration order.

### A remote composition

The RPC boundary uses Effect's own HTTP, WebSocket, and RPC modules, which ship
inside `effect`. A Node host adds the platform bindings and a serialization
format:

```bash
pnpm add @effect/platform-node
```

See [Serve the control plane over RPC](/guides/serve-over-rpc/).

### Credential storage

The credential boundary needs a store and a cipher. `CredentialStore.layerMemory`
and `WebCryptoCipher.layer` need nothing beyond this package;
`SqlCredentialStore.layer` needs the same database packages a durable
composition adds. See [Store and resolve a credential](/guides/store-credentials/).

## Next step

Run one plan through approval and launch in the [Quickstart](/quickstart/).
