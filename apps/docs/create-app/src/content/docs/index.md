---
title: "@smthrs/create-app"
description: "Declare a Smithers app in one PACKAGE.ts: a file router that names pages, panes, flows, and the three layer files a flow inherits, plus the Vite plugin, the Cloudflare targets, and the replay test harness that go with it."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/create-app/docs/README.md"
---

`@smthrs/create-app` turns a directory into a Smithers app. One `PACKAGE.ts`
declares the app. Everything else is named by where it sits: pages, panes,
flows, and the three layer files a flow inherits.

An app built this way is a Vite project that builds into a Cloudflare Worker
plus a static bundle. The package supplies five things:

- The **authoring constructors**: `CreateApp`, `defineAgent`, `defineSandbox`,
  `defineTools`, `defineFlow`, and `definePane`.
- The **file router**, which walks the app root and derives every route, every
  pane name, and every flow's three layers from file location alone.
- The **`smithers-routes` executable**, which writes the two generated route
  tables and checks them for drift.
- The **Vite plugin**, which regenerates those tables in dev and serves the
  declared brand as CSS custom properties.
- The **runtime and test harness**: `layerFor` composes the services one routed
  flow runs under, and `cachedModelTest` replays a flow against a recorded
  model fixture with no network and no API key.

Two templates ship with the package, and
[`smithers-build create-app`](/reference/cli/) copies one of them into a new
directory.

## Who uses this package

App authors, and the hosts that run their flows. If you are scaffolding a chat
or pipeline app that reaches a model, deploys as one Cloudflare Worker, and
keeps its flows in files, this package is the whole authoring surface. If you
are writing a flow library rather than an app, [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) and
[`@smthrs/agent`](https://agent.smithers.sh/reference/api/) are the layers underneath.

## Install

The package is private and is not published to a registry. Scaffold an app from
a source checkout instead:

```bash
pnpm exec smithers-build create-app ledger
```

For the requirements, the two templates, and what the scaffold rewrites, see
[Installation](/installation/).

## The smallest declaration

`PACKAGE.ts` is the only file that declares anything about the app as a whole:

```ts
import { CreateApp } from "@smthrs/create-app"

export const App = CreateApp({
  name: "ledger",
  brand: { name: "Ledger", tokens: { accent: "#5288c2" } },
  deploy: { cloudflare: { workerName: "ledger", domain: "ledger.example.com" } }
})
```

`App.manifest` is what the browser shell reads. `App.routes`, `App.dev`,
`App.build`, and `App.deploy` are ordinary [`@smthrs/targets`](https://targets.smithers.sh/reference/api/)
rules, so putting them in the package's target map makes them addressable as
`//:routes`, `//:dev`, `//:build`, and `//:deploy`.

Everything else is a file in a known place:

| File                   | Export    | Constructor       |
| ---------------------- | --------- | ----------------- |
| `AGENT.ts`             | `Agent`   | `defineAgent`     |
| `SANDBOX.ts`           | `Sandbox` | `defineSandbox`   |
| `TOOLS.ts`             | `Tools`   | `defineTools`     |
| `flows/<id>/flow.ts`   | `Flow`    | `defineFlow`      |
| `app/panes/<name>.tsx` | `Pane`    | `definePane`      |
| `app/**/page.tsx`      | default   | a React component |
| `app/layout.tsx`       | default   | a React component |

A flow never names a model. Its seat comes from the nearest ancestor
`AGENT.ts`, which is why moving one file moves every flow below it to another
seat. The full rule is in [Layer files](/concepts/layers/).

## The package at a glance

Each subpath is a separate entry point, and each has a runtime class the
package's own bundle test holds it to:

| Import                         | Runtime                | What it holds                                        |
| ------------------------------ | ---------------------- | ---------------------------------------------------- |
| `@smthrs/create-app`           | Node                   | `CreateApp` plus everything in `./app`, flat         |
| `@smthrs/create-app/app`       | browser, workerd, Node | The layer, flow, and manifest constructors and types |
| `@smthrs/create-app/ui`        | browser, workerd, Node | `definePane`, the card schemas, and `TurnFrame`      |
| `@smthrs/create-app/runtime`   | browser, workerd, Node | `materializeFlow` and `layerFor`                     |
| `@smthrs/create-app/package`   | Node                   | `CreateApp` over `@smthrs/targets`                   |
| `@smthrs/create-app/router`    | Node                   | The file router and the two renderers                |
| `@smthrs/create-app/vite`      | Node                   | The Vite plugin and the virtual modules              |
| `@smthrs/create-app/testing`   | Node                   | `cachedModelTest` and the recording seam             |
| `@smthrs/create-app/routesBin` | Node                   | The body of the `smithers-routes` executable         |

Every export of every subpath, with signatures, is on the
[API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): requirements, the scaffold, and what the
  `link:` rewrite does.
- [Quickstart](/quickstart/): scaffold an app, route it, replay its test,
  and add a pane of your own.
- Concepts: [file routing](/concepts/routing/),
  [layer files](/concepts/layers/), and
  [the generated route tables](/concepts/generated-routes/).
- Guides: [add a flow](/guides/add-a-flow/),
  [add a pane](/guides/add-a-pane/), [add a page](/guides/add-a-page/),
  [brand an app](/guides/brand-an-app/),
  [test a flow](/guides/test-a-flow/),
  [run a routed flow from your own host](/guides/host-a-turn/), and
  [deploy to Cloudflare](/guides/deploy-to-cloudflare/).
- Reference: [the two templates](/reference/templates/),
  [the command line](/reference/cli/), and the
  [API reference](/reference/api/).
- [Troubleshooting](/troubleshooting/): the refusals the router, the
  runtime, and the test harness report, and what to change for each.
