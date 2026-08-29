# The Aomi Worker

One Cloudflare Worker serves the whole app on `aomi.smithers.sh`: the built SPA
as static assets, the `/api/*` seams, and the agent turn itself. There is no
second deployable and no origin server.

## Layout

| File | What it is |
| --- | --- |
| `wrangler.jsonc` | Worker name, custom domain, assets, Durable Object bindings, vars |
| `index.ts` | The router. One switch over `Routes` from `src/api.ts`; everything else falls through to `ASSETS` |
| `env.ts` | The bindings, as an interface. Nothing else reads configuration |
| `AppSession.ts` | One Durable Object per session: transcript, cards, saved flows |
| `turn.ts` | One agent turn as an NDJSON stream of `TurnFrame` lines |
| `seats.ts` | `anthropic:<model>` resolved to a live model over workerd's `fetch` |
| `crypto.ts` | `effect/Crypto` over WebCrypto, because effect ships no Worker layer |

## Routes

| Method and path | Answer |
| --- | --- |
| `POST /api/agent/turn` | NDJSON stream of `TurnFrame`, forwarded from the session object |
| `POST /api/agent/turn/cancel` | `{ cancelled }` |
| `GET /api/session?id=` | `SessionState` |
| `GET /api/session` | `{ sessions: [] }` — the shell keeps its own list |
| `GET /api/flows?sessionId=` | File flows from `routes.gen.ts` plus the session's saved flows |
| `POST /api/flows/run` | `{ executionId }` |
| `GET /api/health` | `{ ok, build, app }` |
| anything else | `env.ASSETS.fetch(request)` |

`assets.run_worker_first` is scoped to `/api/*`, so an asset request never wakes
this code. An unrouted `/api/*` path answers this Worker's own JSON 404 rather
than the SPA's `index.html`.

## Local development

```sh
pnpm install
cp .dev.vars.example .dev.vars   # then fill in ANTHROPIC_API_KEY
pnpm dev
```

`pnpm dev` runs Vite, and `@cloudflare/vite-plugin` runs `worker/index.ts`
inside workerd in the same process. Durable Objects, the SQLite storage, and the
assets binding are all local. `.dev.vars` supplies the secrets; it is
gitignored.

## Deploy

```sh
pnpm build                     # vite build: dist/client (SPA) + dist/aomi-smithers-demo (Worker)
wrangler deploy                # from the app root, with NO --config
```

`wrangler deploy` must run from the app root **without** `--config`. The build
writes `.wrangler/deploy/config.json`, and wrangler follows that redirect only
when no `--config` flag is given: `resolveWranglerConfigPath` in
`node_modules/wrangler/wrangler-dist/cli.js:2942` returns early with
`redirected: false` as soon as `--config` is set. Passing
`--config worker/wrangler.jsonc` makes wrangler bundle `worker/index.ts` with
esbuild alone, which fails on `virtual:smthrs-app/manifest` — the create-app
plugin's virtual module, reachable from `routes.gen.ts`. `package.json`'s
`deploy` script and `CreateApp`'s deploy target both still pass `--config`; both
need the flag dropped.

Credentials, exported in the deploying shell:

```sh
export CLOUDFLARE_API_TOKEN=<token with Workers Scripts + Workers Routes edit>
export CLOUDFLARE_ACCOUNT_ID=<account id>
```

Secrets, set once per environment and never committed:

```sh
wrangler secret put ANTHROPIC_API_KEY --config worker/wrangler.jsonc
wrangler secret put TEVM_FORK_RPC_URL --config worker/wrangler.jsonc
```

`routes: [{ pattern: "aomi.smithers.sh", custom_domain: true }]` binds the
custom domain. Wrangler creates the DNS record and the certificate on the
`smithers.sh` zone during the first deploy; nothing has to be added in the
dashboard.

### Two config files, one directory

`wrangler.jsonc` here is the source config. `vite build` writes a second one,
`dist/aomi-smithers-demo/wrangler.json`, with `main` and `assets.directory`
rewritten to the build output (`@cloudflare/vite-plugin`'s `getOutputConfig`
and `getAssetsDirectory`), and drops `.wrangler/deploy/config.json` so
`wrangler deploy` picks the generated config up. The plugin never reads
`assets.directory` from the source config; the value there (`../dist/client`)
is for a deploy that bypasses the plugin, and both paths resolve to the same
directory.

### Frozen fields

`name` and `routes` are the Worker's identity. Durable Object storage is keyed
to the Worker name, so renaming it creates a fresh Worker with empty storage and
orphans every session. The custom domain follows the `routes` entry in whichever
config declares it. Neither field changes as part of a routine deploy.

## Milestone 1: the turn is mocked

`APP_MOCK_TURN` defaults to `1` and `worker/turn.ts` streams a fixed sequence —
deltas, one `tevm/getBalance` call, a `chain-balance` pane card, `done` — so the
shell, the pane host, and cancel all work end to end. Setting it to `0` selects
the real `Agent.run` path, which is written out in full in `liveTurn` and does
not run under workerd yet.

Three upstream items in `~/flows/flows` block it, all tracked in `TODO.md`:

1. **The sandbox cannot load.** `packages/harness/src/QuickJSSandbox.ts:22`
   imports `@jitl/quickjs-singlefile-browser-release-sync` and compiles it at
   `:383` with `newQuickJSWASMModuleFromVariant(variant)`. That is a runtime
   `WebAssembly.compile` over bytes, which workerd refuses. The Worker needs the
   wasmfile variant behind a real `.wasm` module import, which means
   `QuickJSSandbox.layer({ variant })`. `packages/agent/src/Agent.ts:474`
   (`layerDefaults`) merges the sandbox layer unconditionally and
   `@smthrs/create-app/runtime`'s `layerFor` composes `layerDefaults`, so every
   real turn dies here before it reaches the model. This is the hard blocker.
2. **Tool sources do not reach the host layer.**
   `@smthrs/create-app/runtime` builds `AgentAction.layerHost` without
   `flows`. `AgentAction.Host` already declares the field
   (`packages/agent/src/AgentAction.ts:88`) and `AgentAction` already forwards
   it to `agent.run`, so the vendored stub's own TODO is stale — it is a
   one-line fix there. `liveTurn` attaches `tools.sources` on `Agent.run`
   directly in the meantime.
3. **No Durable Object engine store.** `packages/database` has no
   `ctx.storage.sql` driver, so a turn runs on `FlowEngine.layerMemory` and its
   journal does not survive the request. `AppSession` persists the app's own
   state (messages, cards, flows) instead, which is why a reload redraws the
   transcript but cannot resume a half-finished turn.

The model transport itself is clear: `@smthrs/model` reaches no Node builtin on
the Worker path, `@smthrs/kernel/HttpClient` re-exports Effect's own
`HttpClient` tag rather than declaring one, and `seats.ts` satisfies it with
`FetchHttpClient.layer`.

## Cancellation

workerd forbids one request touching another request's I/O, so `POST
/api/agent/turn/cancel` does not abort the turn's `fetch`. It aborts an
`AbortController` the turn itself holds, and the turn checks `signal.aborted`
between frames. The controller map and the `busy` flag are transient: an
eviction ends every stream the object was serving, so state that outlived it
would be a lie the next reader could not clear.
