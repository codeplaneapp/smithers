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
| `worker/index.ts`         | The Worker: the API, the agent host, and the assets bucket         |

`routes.gen.ts` and `routes.ui.gen.ts` are generated. Run `pnpm routes` after
adding a page, a pane, a flow, or a layer file; `vite` regenerates them while
it runs, and `smthrs '//:routes'` fails on drift.

## Adding things

A layer file applies to its own directory and everything below it. The nearest
ancestor of each kind wins, and nothing merges, so `flows/build/AGENT.ts` moves
just the `build` flows to another seat and leaves their sandbox and tools alone.

A flow never names a model. Change the seat in `AGENT.ts`.

## Deploying

Set the provider credential and deploy:

```sh
wrangler secret put ANTHROPIC_API_KEY --config worker/wrangler.jsonc
pnpm build
pnpm deploy
```

`domain` in `PACKAGE.ts` and the `routes` entry in `worker/wrangler.jsonc` name
the same hostname. Point both at a zone your Cloudflare account owns before the
first deploy.
