# @smthrs/create-app

Declare a Smithers app in one `PACKAGE.ts`. Everything else is named by where
it sits: pages, panes, flows, and the three layer files a flow inherits.

```sh
pnpm add @smthrs/create-app
smthrs create-app my-app
```

## The authoring surface

```ts
// PACKAGE.ts
import { CreateApp } from "@smthrs/create-app"

export const App = CreateApp({
  name: "ledger",
  brand: { name: "Ledger", tokens: { accent: "#5288c2" } },
  deploy: { cloudflare: { workerName: "ledger", domain: "ledger.example.com" } }
})
```

`App` carries the manifest plus four targets: `routes` regenerates the route
tables, `dev` serves, `build` bundles, and `deploy` ships. Put them in the
package's target map and the `smthrs` CLI addresses them as `//:dev`,
`//:build`, and so on.

| File                   | Export    | Constructor       |
| ---------------------- | --------- | ----------------- |
| `AGENT.ts`             | `Agent`   | `defineAgent`     |
| `SANDBOX.ts`           | `Sandbox` | `defineSandbox`   |
| `TOOLS.ts`             | `Tools`   | `defineTools`     |
| `flows/<id>/flow.ts`   | `Flow`    | `defineFlow`      |
| `app/panes/<name>.tsx` | `Pane`    | `definePane`      |
| `app/**/page.tsx`      | default   | a React component |
| `app/layout.tsx`       | default   | a React component |

A layer file applies to its own directory and everything below it. The nearest
ancestor of each kind wins and nothing merges, so `flows/build/AGENT.ts` moves
the build flows to another seat and leaves their sandbox and tools alone. The
app root must provide all three, which is what makes resolution terminate.

A flow never names a model. Its seat comes from the resolved `AGENT.ts`.

## Public API

| Import                       | What it holds                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `@smthrs/create-app`         | Both halves, flat: `CreateApp` plus everything in `./app`.                                         |
| `@smthrs/create-app/app`     | Browser-safe: `defineAgent`, `defineSandbox`, `defineTools`, `defineFlow`, and the manifest types. |
| `@smthrs/create-app/package` | Node only: `CreateApp` over `@smthrs/targets`.                                                     |
| `@smthrs/create-app/ui`      | `definePane`, `PaneRegistry`, the card schemas, and `TurnFrame`.                                   |
| `@smthrs/create-app/router`  | `discover`, `render`, `renderUi`, `renderAll`, `writeRoutes`, and `RouterError`.                   |
| `@smthrs/create-app/runtime` | `materializeFlow` and `layerFor`: a routed flow made executable.                                   |
| `@smthrs/create-app/vite`    | `createApp` (the plugin) and `brandCss`.                                                           |
| `@smthrs/create-app/testing` | `cachedModelTest`, `runCachedModelTest`, and `recordModel`.                                        |

`./app` imports no build rules, so `routes.gen.ts` pulls it into the Worker and
browser bundles; `sideEffects: []` lets a bundler drop the Node half.

## Generated files

`smthrs-routes` writes two files at the app root and never anything else.

- `routes.gen.ts` — every flow with its three resolved layers, plus the pane
  names. No React import, so the Worker and a plain vitest run load it.
- `routes.ui.gen.ts` — the layout, the pages, and the pane components.

```sh
smthrs-routes           # write
smthrs-routes --check   # exit 1 on drift, which is what //:routes runs
```

The Vite plugin regenerates them on start and on every routed file change, so
`pnpm dev` never serves a stale table.

## Testing a flow

```ts
cachedModelTest("chat answers a balance question", {
  fixture: new URL("./fixtures/balance.json", import.meta.url),
  flow: "chat",
  payload: { message: "What is vitalik.eth's balance?" },
  expect: (output) => {
    expect(output.answer).toContain("ETH")
  }
})
```

Replay is the default: no network, no key. `SMTHRS_RECORD=1` records against
the live seat named by `options.live` and rewrites the fixture.

See [the create-app guide](../../docs/pages/create-app.md).
