# __APP_NAME__

The Aomi Build page as a Smithers app: a chat flow and a build pipeline over an
in-memory EVM fork, six panes, an in-Worker agent, and a Cloudflare deploy.

This is the reference layout. It is larger than the `default` template on
purpose: every rule the router enforces is exercised somewhere in it.

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
| `flows/chat/`             | The conversation: chain questions in, an answer plus cards out     |
| `flows/build/`            | The pipeline, with its own `AGENT.ts` overriding the root one      |
| `app/**/page.tsx`         | One page at `/<dir>`; `app/page.tsx` is `/`                        |
| `app/panes/<name>.tsx`    | One pane the agent renders by name                                 |
| `tools/tevm.ts`           | Chain reads against an in-memory fork                              |
| `tools/ui.ts`             | `ui/pane` and `ui/html`, the two ways to put a card on screen      |
| `tools/promote.ts`        | Writes a flow, its test, and its fixture back into `flows/`        |
| `worker/`                 | The Worker: session Durable Object, turn stream, seat resolution   |
| `src/`                    | The browser shell: routing, transcript, brand, components          |

`routes.gen.ts` and `routes.ui.gen.ts` are generated. Run `pnpm routes` after
adding a page, a pane, a flow, or a layer file; `vite` regenerates them while it
runs, and `smthrs '//:routes'` fails on drift.

`flows/build/AGENT.ts` is the layer rule in one file: it moves the build
pipeline to its own seat and teaching, and leaves its sandbox and tools
resolving to the root. Nothing merges.

## Tests

```sh
pnpm test          # replay every flow's recorded fixture, plus the wire contract
pnpm test:record   # re-record against the live seat; needs a provider key
```

## Deploying

```sh
wrangler secret put ANTHROPIC_API_KEY --config worker/wrangler.jsonc
wrangler secret put TEVM_FORK_RPC_URL --config worker/wrangler.jsonc
pnpm build
pnpm deploy
```

`domain` in `PACKAGE.ts` and the `routes` entry in `worker/wrangler.jsonc` name
the same hostname. Point both at a zone your Cloudflare account owns before the
first deploy.
