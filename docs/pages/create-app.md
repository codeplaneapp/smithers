# Building an app

`@smthrs/create-app` turns a directory into a Smithers app. One file declares
the app; everything else is named by where it sits.

```sh
smthrs create-app ledger
cd ledger
pnpm install
pnpm routes
pnpm dev
```

`--template aomi` scaffolds the reference app instead of the minimal one.

## CreateApp

`PACKAGE.ts` is the whole declaration.

```ts
import { CreateApp } from "@smthrs/create-app"
import { Smithers as S } from "@smthrs/targets"

export const App = CreateApp({
  name: "ledger",
  brand: {
    name: "Ledger",
    fonts: { body: "Inter, sans-serif", googleFonts: ["Inter:wght@400;600"] },
    tokens: { accent: "#5288c2", background: "#ffffff", foreground: "#09090b" }
  },
  nav: [{ label: "App", items: [{ label: "Chat", href: "/" }] }],
  deploy: { cloudflare: { workerName: "ledger", domain: "ledger.example.com" } }
})

export const Package = S.Package({
  targets: {
    routes: App.routes,
    dev: App.dev,
    build: App.build,
    deploy: App.deploy,
    default: S.Alias(App.dev)
  }
})
```

`App.manifest` is the serializable half: the brand, the navigation, the source
directories, and the deploy target. The Vite plugin serves it to the browser as
`virtual:smthrs-app/manifest`.

The four targets are ordinary `@smthrs/targets` rules, so they run on today's
CLI with no new target kind.

| Target   | Rule              | What it does                                             |
| -------- | ----------------- | ---------------------------------------------------------- |
| `routes` | `S.Generate`      | Writes the two generated files; checks drift without `--write` |
| `dev`    | `S.Shell.Serve`   | `vite --port 5173`, workerd in the loop, network on       |
| `build`  | `S.Shell.Build`   | `vite build` into `dist`                                  |
| `deploy` | `S.Shell.Run`     | `wrangler deploy`, gated on `build`, approval required     |

`dirs` moves the three source directories; it defaults to
`{ app: "app", flows: "flows", tools: "tools" }`. `deploy.cloudflare.config`
defaults to `worker/wrangler.jsonc`.

`deploy` names `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as secrets and
declares `approval: "required"`, so shipping is never a side effect of a build.

## Layer files

Three files carry everything a flow needs and does not declare itself.

```ts
// AGENT.ts
import { defineAgent } from "@smthrs/create-app/app"

export const Agent = defineAgent({
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You answer questions about the ledger."],
  limits: { calls: 32 },
  maxFrames: 12
})
```

```ts
// SANDBOX.ts
import { defineSandbox } from "@smthrs/create-app/app"

export const Sandbox = defineSandbox({
  limits: { heapBytes: 128 * 1024 * 1024, interruptChecks: 1000, wallClockMs: 30_000 }
})
```

```ts
// TOOLS.ts
import { defineTools } from "@smthrs/create-app/app"
import { ledger } from "./tools/ledger.ts"

export const Tools = defineTools([ledger])
```

`AGENT.ts` carries the seat and the teaching. A flow file never names a model,
so changing providers is one line in one file. `SANDBOX.ts` carries the compute
budget one cell may burn; `wallClockMs` is the whole-evaluation backstop, host
calls included. `TOOLS.ts` carries the binding sources every cell reaches as
`ctx.call("<source>/<flow>", input)`.

The split follows what owns what: how many tools a step may reach for is a
property of the agent, so `limits.calls` is on `AGENT.ts`.

### Nearest-ancestor resolution

A layer file applies to its own directory and everything below it. For each of
the three kinds, the nearest ancestor wins. Nothing merges.

```
AGENT.ts            SANDBOX.ts     TOOLS.ts
flows/
  chat/flow.ts                          -> AGENT.ts,            SANDBOX.ts, TOOLS.ts
  build/
    AGENT.ts
    flow.ts                             -> flows/build/AGENT.ts, SANDBOX.ts, TOOLS.ts
    plan/flow.ts                        -> flows/build/AGENT.ts, SANDBOX.ts, TOOLS.ts
```

`flows/build/AGENT.ts` moves the build flows to another seat and leaves their
sandbox and tools resolving to the root. The app root must provide all three
kinds; that is what makes resolution terminate, and a flow with no ancestor of
some kind is a `missing_layer` error rather than a silent default.

## Flows

```ts
// flows/chat/flow.ts
import { defineFlow } from "@smthrs/create-app/app"
import * as Schema from "effect/Schema"

export const Flow = defineFlow({
  description: "Answer a question about the ledger.",
  payload: { message: Schema.String },
  output: Schema.Struct({ answer: Schema.String, cards: Schema.Array(Schema.String) }),
  chat: true,
  prompt: ({ message }) => message,
  system: ["Render every result with ui/pane and keep `answer` short."]
})
```

The directory is the name: `flows/chat/flow.ts` is the flow `chat`, and
`flows/build/plan/flow.ts` is `build/plan`. Every segment must be lowercase
kebab-case. `flow.mdx` routes the same way as `flow.ts`.

`system` is appended after the resolved `AGENT.ts` teaching: the layer says what
the app is, the flow says what this task is. `chat: true` keeps the realm and
the transcript between turns; the default runs to completion from the payload.

## definePane

A pane is a React component the agent puts on screen by name.

```tsx
// app/panes/balance.tsx
import { definePane } from "@smthrs/create-app/ui"
import * as Schema from "effect/Schema"

export const Pane = definePane({
  props: Schema.Struct({ address: Schema.String, wei: Schema.String }),
  title: "Balance",
  fullscreen: false,
  render: ({ address, wei }) => <dl><dt>{address}</dt><dd>{wei}</dd></dl>
})
```

The file name is the pane name, so this is `balance`. The agent renders it with
`ctx.call("ui/pane", { name: "balance", props })`, and the shell embeds it as a
card in the transcript. `fullscreen` decides whether the card header offers a
maximize control; the maximized presentation is the same component in an
overlay, never a second render.

Props arrive over the wire as `unknown`, so a registry holds the erased form:

```ts
const definition = panes[card.name]
if (definition !== undefined) definition.renderUnknown(card.props, context)
```

`renderUnknown` decodes with the pane's own schema and throws the schema's error
when the props are rejected, which is what lets a shell show the message in
place of the pane.

## Pages

`app/**/page.tsx` is the page at `/<dir>`, and `app/page.tsx` is `/`. Each one
default-exports a React component. `app/layout.tsx` is the shell layout and is
optional.

## The generated files

`smthrs-routes` writes two files at the app root and never anything else.

```sh
smthrs-routes           # write
smthrs-routes --check   # exit 1 on drift; this is what `smthrs '//:routes'` runs
```

`routes.gen.ts` holds every flow with its three resolved layers, plus the pane
names. It imports no React and no virtual module, so the Worker bundle and a
plain vitest run both load it.

```ts
export const paneNames = ["balance"] as const

export const flows = [
  { id: "chat", file: "flows/chat/flow.ts", spec: flow_chat.Flow, agent: layer0.Agent, sandbox: layer1.Sandbox, tools: layer2.Tools },
] as const
```

`routes.ui.gen.ts` holds the layout, the pages, and the pane components for the
browser.

```ts
export const layout = layoutModule.default
export const pages = [{ route: "/", file: "app/page.tsx", component: page__.default }] as const
export const panes = { "balance": pane_balance.Pane } as const
```

Both are deterministic: the router sorts every input, so two identical trees
render byte-identical files and CI can treat any difference as drift.

The Vite plugin regenerates them when the config resolves and whenever a routed
file appears or disappears, so `pnpm dev` never serves a stale table.

```ts
// vite.config.ts
import { createApp } from "@smthrs/create-app/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({ plugins: [createApp(), react()] })
```

The plugin also serves the brand as `virtual:smthrs-app/brand.css`. Each token
becomes a `--house-*` custom property and, where one exists, the
`@smthrs/ui` styleguide property the components actually read: `accent` becomes
both `--house-accent` and `--brand`. A token the brand does not declare is not
emitted, so a brand is a patch rather than a theme.

## Running a flow

`@smthrs/create-app/runtime` turns a routed flow into an executable one.

```ts
import { layerFor, materializeFlow } from "@smthrs/create-app/runtime"

const materialized = materializeFlow(flow.id, flow.spec, flow.agent)
const host = layerFor({
  agent: flow.agent,
  sandbox: flow.sandbox,
  tools: flow.tools,
  seats: { resolve: (id) => resolveSeat(id) },
  crypto: NodeCrypto.layer
})
```

`materializeFlow` builds the `AgentAction` and the `Flow` from the spec and the
resolved agent, which is why no flow file names a seat. `layerFor` composes the
host for one flow: the agent host with the sandbox limits both layer files
imply, the seat resolver, the agent loop, the action implementations, an
in-memory engine, and the caller's crypto.

## Testing a flow

```ts
import { cachedModelTest } from "@smthrs/create-app/testing"

cachedModelTest("chat answers a balance question", {
  fixture: new URL("./fixtures/balance.json", import.meta.url),
  flow: "chat",
  payload: { message: "What is 0xabc's balance?" },
  expect: (output) => { expect(output.answer).toContain("ETH") }
})
```

Replay is the default: the fixture is decoded and served by a recorded model, so
the test needs no network and no key. `SMTHRS_RECORD=1` builds the live model
from `options.live`, records every request and its events, and rewrites the
fixture; a run with no `live` fails with that message rather than recording
against a noop.

The default loader re-runs the router and imports only the named flow and its
three layer files. `routes.gen.ts` is deliberately not used: it imports every
page, and a model test has no business loading the UI graph.

## smthrs create-app

```sh
smthrs create-app <dir> [--template default|aomi] [--no-link]
```

The directory's name becomes the app name, so it must be lowercase letters,
digits, `.`, `_`, and `-`. The directory must not already hold anything.

`default` is a minimal app: one chat flow, one pane, one page, one mock tool.
`aomi` is the reference app: two flows with a layer override, six panes, twelve
pages, chain tools, and a Worker that runs the agent.

When the CLI is running from a checkout of this repository, the scaffolded
manifest's `@smthrs/*` dependencies are rewritten to `link:` paths into that
checkout, because those packages are not published yet. `--no-link` keeps the
declared versions.
