---
title: "Templates"
description: "The two templates smithers-build create-app copies: what each one routes, which packages it depends on, which scripts it defines, and which parts are wired."
sidebar:
  order: 1
---

Two templates ship inside this package. `smithers-build create-app` copies one
of them into a new directory and substitutes the app name.

```bash
pnpm exec smithers-build create-app ledger                 # default
pnpm exec smithers-build create-app ledger --template aomi # aomi
```

|                          | `default`                               | `aomi`                        |
| ------------------------ | --------------------------------------- | ----------------------------- |
| Files copied             | 28                                      | 96                            |
| Pages                    | 1                                       | 12                            |
| Panes                    | 1                                       | 6                             |
| Flows                    | 1                                       | 2                             |
| Tool sources             | 1                                       | 3                             |
| Agent host in the Worker | not shipped                             | shipped, mock turn by default |
| Fixture recording        | not shipped                             | `pnpm test:record`            |
| Private dependencies     | `@smthrs/create-app`, `@smthrs/targets` | those two plus `@smthrs/ui`   |

Pick `default` to start an app. Pick `aomi` to read a worked example: it is the
reference layout, and every rule the router enforces is exercised somewhere in
it.

## Shared shape

Both templates are the same app skeleton:

| Path                                 | What it is                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `PACKAGE.ts`                         | `CreateApp()`: brand, navigation, and the dev, build, and deploy targets         |
| `AGENT.ts`, `SANDBOX.ts`, `TOOLS.ts` | The root layer files every flow inherits                                         |
| `flows/<id>/flow.ts`                 | One flow, named by its directory                                                 |
| `app/**/page.tsx`                    | One page at `/<dir>`; `app/page.tsx` is `/`                                      |
| `app/panes/<name>.tsx`               | One pane the agent renders by name                                               |
| `app/layout.tsx`                     | The shell layout                                                                 |
| `tools/*.ts`                         | Flow bindings a cell reaches as `ctx.call("<source>/<flow>")`                    |
| `worker/`                            | The Cloudflare Worker: the API and the assets bucket                             |
| `src/`                               | The browser entry point and styles                                               |
| `routes.gen.ts`, `routes.ui.gen.ts`  | Generated. Run `pnpm routes` after adding a routed file                          |
| `.smithers/`                         | The build-graph workspace: runtime, package manager, sandboxes, and build agents |

Both carry the same scripts, and `aomi` adds one:

| Script                      | Command                      |
| --------------------------- | ---------------------------- |
| `dev`                       | `vite`                       |
| `build`                     | `vite build`                 |
| `preview`                   | `vite preview`               |
| `deploy`                    | `wrangler deploy`            |
| `routes`                    | `smithers-routes`            |
| `routes:check`              | `smithers-routes --check`    |
| `typecheck`                 | `tsc --noEmit`               |
| `test`                      | `vitest run`                 |
| `test:record` (`aomi` only) | `SMTHRS_RECORD=1 vitest run` |

The `.smithers/` directory is the build graph's own configuration, not the
app's. Its `agents.ts` declares the coding agents `smithers-build` may run;
the in-app agent seats live in `AGENT.ts` files.

## default

The smallest app that routes, runs, tests, and deploys.

- **Seat.** `anthropic:claude-sonnet-4-5`, 16 calls, 8 frames.
- **Sandbox.** 128 MiB heap, 1000 interrupt checks, 30 s wall clock.
- **Tools.** One source, `ui`, holding `ui/pane` and `ui/html`.
- **Flow.** `chat`, a chat flow whose output is an answer plus the ids of the
  cards it emitted.
- **Page.** `/`, a composer that posts to `/api/turn` and prints the response
  body.
- **Pane.** `message`, a heading, a body, and an optional tone.
- **Test.** `flows/chat/flow.e2e.ts`, replaying
  `flows/chat/fixtures/answer.json`. It asserts against the cards the `ui`
  binding actually collected rather than against the ids the model reported,
  because a model that answered in prose can still name a card in its output.

The Worker serves `GET /api/routes`, which reports what the router found, and
answers `POST /api/turn` with HTTP 501. That is deliberate: the template ships
the router, the flow, the pane, the tool, the test, and the deploy target, and
leaves the agent host to you. The page says so above the composer rather than
only in the response. Building it is
[Run a routed flow from your own host](../guides/host-a-turn.md).

The template ships no live model, so it has no `test:record` script. Add a
`live` function and pass it to `cachedModelTest` to record; `aomi` has the
worked example.

## aomi

The Aomi Build page as a Smithers app: a chat flow and a build pipeline over an
in-memory EVM fork, six panes, a full Worker, and a Cloudflare deploy.

- **Seats.** The root `AGENT.ts` seats `openai:gpt-5.5` with 32 calls and 12
  frames. `flows/build/AGENT.ts` seats `openai:gpt-5.6-sol` with 64 calls and
  24 frames, which is the layer rule in one file: it moves the build pipeline
  to a stronger seat and leaves its sandbox and tools resolving to the root.
- **Flows.** `chat` (a chat flow, answering chain questions) and `build` (a
  pipeline flow returning a typed `BuildPlan` of files and stages).
- **Pages.** `/`, `/build`, `/overview`, `/projects`, `/providers`,
  `/integrations`, `/settings`, and five under `/operate`.
- **Panes.** `build-files`, `build-plan`, `chain-balance`, `chain-block`,
  `chain-contract`, and `chain-tx`.
- **Tools.** Three sources: `tevm` (`fork`, `getBalance`, `readContract`,
  `call`, `setAccount`, `mine`, `simulate`, `getBlock`), `ui` (`pane`, `html`),
  and `flows` (`show-script`, `write-flow`, which writes a flow, its test, and
  its fixture back into the app's own source tree).
- **Worker.** A router free of `cloudflare:workers` so it can be driven on
  plain Node, one Durable Object per session, an NDJSON turn stream, seat
  resolution over workerd's `fetch`, and a guard that enforces a bearer
  credential, a 64 KiB body cap, and a session-id shape.
- **Tests.** Every flow replays a fixture, plus suites for the wire contract,
  the stream, the turn, the Worker, and the Tevm fork.

### The turn is mocked by default

`APP_MOCK_TURN` defaults to `1`, and the Worker streams a fixed sequence of
frames so the shell, the pane host, and cancellation all work end to end.
Setting it to `0` asks for the real agent path, which is written out in full
but refuses with a message naming two upstream blockers: the QuickJS sandbox
compiles its WebAssembly at runtime, which workerd refuses, and there is no
Durable Object engine store, so a turn's journal does not survive the request.

### What it needs to run

`.dev.vars.example` lists four values, and the template's own README explains
each:

| Variable            | What reads it                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`    | Seat resolution, for the `openai:` seats the template ships                                             |
| `TEVM_FORK_RPC_URL` | The fork test only. The Worker never reads it, so it is not a deploy secret                             |
| `APP_MOCK_TURN`     | The Worker's turn path                                                                                  |
| `APP_API_TOKEN`     | The API guard. Unset means the API is open, which is what `pnpm dev` wants and a public domain does not |

Set `APP_API_TOKEN` as a secret before the first public deploy. See
[Deploy to Cloudflare](../guides/deploy-to-cloudflare.md).

## Adding a template

A template is a directory under `template/` in this package. The scaffold
copies it whole, substitutes `__APP_NAME__` in every `.css`, `.html`, `.json`,
`.jsonc`, `.md`, `.mjs`, `.ts`, and `.tsx` file, and rewrites the `@smthrs/*`
dependencies. Four directory names are never copied, so a checkout that ran the
template's own suite does not ship the result: `node_modules`, `dist`,
`.wrangler`, and `.flows`. `.smithers` is copied, because templates ship one.

Two rules are checked by the package's own suite:

- Every `@smthrs/*` specifier must pin the version the workspace publishes,
  because a scaffolded app is not a workspace member and nothing else holds the
  two in step.
- The template's README must name exactly the private packages it depends on,
  because that paragraph is what a reader consults when a `--no-link` install
  fails.
