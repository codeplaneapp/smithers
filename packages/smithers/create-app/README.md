# @smthrs/create-app

**Documentation:** https://create-app.smithers.sh

Declare a Smithers app in one `PACKAGE.ts`. Everything else is named by where
it sits: pages, panes, flows, and the three layer files a flow inherits.

This package is private at 1.0.0-rc.0 and is not published, so there is nothing
to install from a registry. An app is scaffolded from a source checkout:

```sh
pnpm exec smithers-build create-app my-app
```

`smithers-build` is the binary of `@smthrs/build-cli`, a second private package;
`create-app` is one of its verbs. The scaffold rewrites every `@smthrs/*`
specifier in the copied template to a `link:` path into the checkout it was cut
from, which is how those specifiers resolve. `package.json` carries a full
`publishConfig` with a dist-based export map: it is retained for a future
publish decision and has no effect while the package is private.

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
package's target map and the `smithers-build` CLI addresses them as `//:dev`,
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

Only the app root's `layout.tsx` is a shell layout. A nested `layout.tsx` is an
ordinary file the router ignores, and a file below `app/panes/` is a page rather
than a pane, so `app/panes/deep/page.tsx` is the page `/panes/deep`.

A layer file applies to its own directory and everything below it. The nearest
ancestor of each kind wins and nothing merges, so `flows/build/AGENT.ts` moves
the build flows to another seat and leaves their sandbox and tools alone. The
app root must provide all three, which is what makes resolution terminate.

A flow never names a model. Its seat comes from the resolved `AGENT.ts`.

## Public API

| Import                         | Runtime                | What it holds                                                                                                                                                        |
| ------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/create-app`           | Node                   | Both halves, flat: `CreateApp` plus everything in `./app`.                                                                                                           |
| `@smthrs/create-app/app`       | browser, workerd, Node | `defineAgent`, `defineSandbox`, `defineTools`, `defineFlow`, the spec and manifest types, `defaultDirs`, `defaultCallLimit`, `defaultMaxFrames`.                     |
| `@smthrs/create-app/ui`        | browser, workerd, Node | `definePane`, `PaneRegistry`, `PaneContext`, the card schemas, `AppCard`, and `TurnFrame`.                                                                           |
| `@smthrs/create-app/runtime`   | browser, workerd, Node | `materializeFlow`, `layerFor`, `emptyRegistry`, `LayerError`, `LayerErrorCode`, `SeatProvider`, `LayerOptions`, `MaterializedFlow`.                                  |
| `@smthrs/create-app/package`   | Node                   | `CreateApp` over `@smthrs/targets`, `CreateAppOptions`, `AppTargets`.                                                                                                |
| `@smthrs/create-app/router`    | Node                   | `discover`, `render`, `renderUi`, `renderAll`, `writeRoutes`, `resolveLayer`, `RouterError`, `RouterErrorCode`, `RouterOptions`, `RoutesFileStatus`, `RoutesReport`. |
| `@smthrs/create-app/vite`      | Node                   | `createApp` (the plugin), `brandCss`, `loadManifest`, `brandModuleId`, `manifestModuleId`, `CreateAppPlugin`, `CreateAppPluginOptions`.                              |
| `@smthrs/create-app/testing`   | Node                   | `cachedModelTest`, `runCachedModelTest`, `recordModel`, `replayModelError`, `recording`, `preparedRequest`, `RoutedFlow`, `CachedModelTestOptions`.                  |
| `@smthrs/create-app/routesBin` | Node                   | `runRoutesBin` and `usage`: the body of the `smithers-routes` executable.                                                                                            |

`./app`, `./ui`, and `./runtime` are what a scaffolded app ships: `routes.gen.ts`
pulls `./app` and `./runtime` into the Worker bundle, `routes.ui.gen.ts` pulls
`./ui` into the browser bundle, and `sideEffects: []` lets a bundler drop the
Node half. `test/bundle.test.ts` holds each of the nine to its row by bundling
it, because this package is not in `scripts/browser-check.mjs`'s frozen
inventory.

## Generated files

`smithers-routes` writes two files at the app root and never anything else.

- `routes.gen.ts` — every flow with its three resolved layers, plus the pane
  names. No React import, so the Worker and a plain vitest run load it.
- `routes.ui.gen.ts` — the layout, the pages, and the pane components.

```sh
smithers-routes           # write; exit 2 on a flag given no value
smithers-routes --check   # write nothing, exit 1 on drift
```

`--check` is a standalone convenience, and both templates expose it as
`pnpm routes:check`. The build graph checks drift a different way:
`smithers-build lint '//:routes'` runs the generator in write mode and compares
the declared `changes`. A bare `smithers-build '//:routes'` is the write form
and checks nothing.

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
