# __APP_NAME__

A Smithers app. `PACKAGE.ts` declares it; everything else is named by where it
sits.

```sh
pnpm install
pnpm routes     # write routes.gen.ts and routes.ui.gen.ts
pnpm typecheck
pnpm dev        # vite, with workerd in the loop
```

## Layout

| Path                      | What it is                                                        |
| ------------------------- | ------------------------------------------------------------------ |
| `PACKAGE.ts`              | `CreateApp()`: brand, navigation, and the dev/build/deploy targets |
| `AGENT.ts`                | The seat and teaching every flow below it runs with                |
| `SANDBOX.ts`              | The QuickJS budget every cell runs under                           |
| `TOOLS.ts`                | The flow-binding sources every flow below it can call              |
| `flows/<id>/flow.ts`      | One flow, named by its directory                                   |
| `app/**/page.tsx`         | One page at `/<dir>`; `app/page.tsx` is `/`                        |
| `app/panes/<name>.tsx`    | One pane the agent renders by name                                 |
| `app/layout.tsx`          | The shell layout, optional                                         |
| `tools/*.ts`              | Flow bindings the agent calls as `ctx.call("<source>/<flow>")`     |
| `worker/index.ts`         | The Worker: the API and the assets bucket. `/api/turn` is a stub   |
| `flows/<id>/flow.e2e.ts`  | One flow replayed against a recorded model, so `pnpm test` needs no key |

`routes.gen.ts` and `routes.ui.gen.ts` are generated. Run `pnpm routes` after
adding a page, a pane, a flow, or a layer file. `vite` regenerates them while
it runs, `pnpm routes:check` exits 1 on drift, and `smithers-build lint
'//:routes'` is the form the build graph runs.

## Installing

`pnpm exec smithers-build create-app` rewrites every `@smthrs/*` dependency to
a `link:` path into the checkout the app was scaffolded from, which is how
those specifiers resolve. Two of them are private packages no registry serves:
`@smthrs/create-app` and `@smthrs/targets`. Until those publish, an app moved
off that checkout keeps the links or vendors what it uses.

## What is not wired

`/api/turn` answers HTTP 501 on every request. This template ships the router,
the flow, the pane, the tool, the test, and the deploy target, and leaves the
agent host to you: build it with `layerFor` from `@smthrs/create-app/runtime`,
materialize the routed flow with `materializeFlow`, and stream `TurnFrame`
NDJSON back. The `aomi` template's `worker/` directory is the worked example.

## Adding things

A layer file applies to its own directory and everything below it. The nearest
ancestor of each kind wins, and nothing merges, so `flows/build/AGENT.ts` moves
just the `build` flows to another seat and leaves their sandbox and tools alone.

A flow never names a model. Change the seat in `AGENT.ts`.

## Testing

```sh
pnpm test   # replays flows/chat/fixtures/answer.json; no network, no key
```

Re-recording a fixture needs a `live` model, which this template does not ship.
`flows/chat/flow.e2e.ts` says what to add, and the `aomi` template's
`test/support/liveModel.ts` is the worked example.

## Deploying

```sh
pnpm build
pnpm deploy
```

No provider credential is needed yet: nothing in this template calls a model
from the Worker. Set one with `wrangler secret put` once you have wired
`/api/turn` to a real host, and set the one the seat in `AGENT.ts` names.

`domain` in `PACKAGE.ts` and the `routes` entry in `worker/wrangler.jsonc` name
the same hostname. Point both at a zone your Cloudflare account owns before the
first deploy.
