---
title: "Installation"
description: "What @smthrs/create-app needs to run, how to scaffold an app from a source checkout, what the link: rewrite does to the scaffolded manifest, and the import forms each subpath serves."
sidebar:
  order: 1
---

## Requirements

- Node.js 22.19.0 or later.
- pnpm, for the scaffold command and for the app's own scripts.
- A source checkout of the Smithers repository. The package is private and is
  not published to a registry, so there is nothing to `pnpm add`.

## Scaffold an app

`create-app` is a verb of `smithers-build`, the executable of
[`@smthrs/build-cli`](/pkg/build-cli). The templates ship inside this package,
and the CLI resolves them through Node rather than by path:

```bash
pnpm exec smithers-build create-app ledger
```

The directory name becomes the app name, so it must match
`^[a-z0-9][a-z0-9._-]*$`. The target directory must be absent or empty. Two
options change what you get:

| Option                    | Default                        | What it does                                                                                           |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `--template <name>`, `-t` | `default`                      | Which template to copy. `default` and `aomi` are the two that ship.                                    |
| `--link` / `--no-link`    | link when a checkout was found | Whether the scaffolded `@smthrs/*` dependencies point at the checkout or keep their declared versions. |

The two templates are described in
[Templates](./reference/templates.md), and the command's full argument list is
in the [command reference](./reference/cli.md).

## What the scaffold rewrites

Copying is the whole scaffold, plus two rewrites.

Every `.css`, `.html`, `.json`, `.jsonc`, `.md`, `.mjs`, `.ts`, and `.tsx` file
has `__APP_NAME__` replaced by the directory's name. Every other file is copied
byte for byte.

Then, unless you passed `--no-link`, every `@smthrs/*` entry in the scaffolded
`package.json` becomes a `link:` path into the checkout the templates came
from:

```json
{
  "dependencies": {
    "@smthrs/core": "link:/path/to/smithers/packages/smithers/flows/core",
    "@smthrs/create-app": "link:/path/to/smithers/packages/smithers/create-app"
  }
}
```

Each package is found by the name its own manifest declares, not by its
directory: `@smthrs/targets` lives at `packages/smithers/build/targets`, and
`@smthrs/core` at `packages/smithers/flows/core`. A dependency the checkout
does not carry keeps its declared version.

The rewrite is what makes a scaffolded app installable today. Some of the
packages a template depends on are private and reach no registry:
`@smthrs/create-app` and `@smthrs/targets` for the `default` template, and
`@smthrs/ui` as well for `aomi`. An app moved away from that checkout keeps the
links, vendors what it uses, or waits for those packages to publish.

## Install the app

```bash
cd ledger
pnpm install
```

The install brings the app's own stack with it: React 19, Vite 8, Vitest 4,
wrangler, and the Cloudflare Vite plugin. It also installs this package's
executable, `smithers-routes`, which the app's `pnpm routes` script runs.

## Import forms

An app imports the subpath whose runtime class matches the file doing the
importing. There is no barrel that serves all of them:

```ts
// PACKAGE.ts, in Node.
import { CreateApp } from "@smthrs/create-app"

// AGENT.ts, SANDBOX.ts, TOOLS.ts, and flow files: browser, workerd, or Node.
import { defineAgent, defineFlow, defineSandbox, defineTools } from "@smthrs/create-app/app"

// app/panes/<name>.tsx, in the browser.
import { definePane } from "@smthrs/create-app/ui"

// A host that runs a routed flow.
import { layerFor, materializeFlow } from "@smthrs/create-app/runtime"

// vite.config.ts.
import { createApp } from "@smthrs/create-app/vite"

// A flow's test file.
import { cachedModelTest } from "@smthrs/create-app/testing"
```

`./app`, `./ui`, and `./runtime` reach no `node:` builtin, which is what lets a
Worker bundle and a browser bundle load them. `sideEffects: []` lets a bundler
drop the Node half when only those three are imported. The package's own
`test/bundle.test.ts` bundles each subpath to hold it to its class.

Two subpath forms are refused by the export map: `@smthrs/create-app/internal/*`
and `@smthrs/create-app/*/index`. `@smthrs/create-app/package.json` is
exported.

## Optional peer dependencies

Each peer is needed only by the subpath that uses it, so an app that skips a
subpath skips its peer:

| Peer     | Range     | Needed by                                                |
| -------- | --------- | -------------------------------------------------------- |
| `react`  | `^19.0.0` | `./ui`, and any page or layout                           |
| `vite`   | `^8.0.0`  | `./vite`                                                 |
| `vitest` | `^4.0.0`  | `./testing`                                              |
| `tsx`    | `^4.20.0` | `loadManifest` in `./vite`, which evaluates `PACKAGE.ts` |

An app that passes its own manifest to the Vite plugin never needs `tsx`. See
[Brand an app](./guides/brand-an-app.md).

## Next step

Scaffold, route, and test an app end to end in the
[Quickstart](./quickstart.md).
