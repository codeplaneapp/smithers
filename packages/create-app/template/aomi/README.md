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

`pnpm exec smithers-build create-app` rewrites every `@smthrs/*` dependency to
a `link:` path into the checkout the app was scaffolded from, which is how
those specifiers resolve. Four of them are private packages no registry serves:
`@smthrs/create-app`, `@smthrs/targets`, `@smthrs/ui`, and
`@smthrs/ui-styleguide`. Until those publish, an app moved off that checkout
keeps the links or vendors what it uses.

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
adding a page, a pane, a flow, or a layer file. `vite` regenerates them while it
runs, `pnpm routes:check` exits 1 on drift, and `smithers-build lint
'//:routes'` is the form the build graph runs.

`flows/build/AGENT.ts` is the layer rule in one file: it moves the build
pipeline to its own seat and teaching, and leaves its sandbox and tools
resolving to the root. Nothing merges.

## Tests

```sh
pnpm test          # replay every flow's recorded fixture, plus the wire contract
pnpm test:record   # re-record against the live seat; needs a provider key
```

A recording reads the credential for the provider `AGENT.ts` names, and
`test/tevm.test.ts` reads `TEVM_FORK_RPC_URL` for its fork. Put both in
`.dev.vars` for local runs; see `.dev.vars.example`.

## Deploying

Set the credential for the provider the app's seat names. `AGENT.ts` seats
`openai:gpt-5.5` and `flows/build/AGENT.ts` seats `openai:gpt-5.6-sol`, so this
template needs `OPENAI_API_KEY`. Change the seats and the secret changes with
them: `worker/seats.ts` reads `ANTHROPIC_API_KEY` for an `anthropic:` seat.

```sh
wrangler secret put OPENAI_API_KEY --config worker/wrangler.jsonc
pnpm build
pnpm deploy
```

The deployed API is unauthenticated. Read the note at the top of
`worker/router.ts` before you point a public domain at it.

`domain` in `PACKAGE.ts` and the `routes` entry in `worker/wrangler.jsonc` name
the same hostname. Point both at a zone your Cloudflare account owns before the
first deploy.
