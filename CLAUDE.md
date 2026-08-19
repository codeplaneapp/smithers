# Smithers

Durable agent-workflow runtime/control plane. Product UI: `../multi`. Hosted forge: `../plue`.

`AGENTS.md` links here; edit this file.

## Find things

- `packages/{graph,scheduler,engine,driver}` — workflow graph, decisions, execution, task driving.
- `packages/{db,server,gateway,protocol,control-plane}` — persistence and control-plane contracts/services.
- `packages/{agents,sandbox,vcs,time-travel,memory,scorers,openapi}` — adapters and runtime capabilities.
- `packages/{gateway-client,gateway-react,gateway-ui,components,tui}` — gateway clients and run UIs.
- `packages/smithers` — published `smthrs` facade; implement in the owning package, then export here.
- `apps/cli` — CLI, MCP server, gateway command, local workflow tools.
- `.smithers` — built-in/init workflow pack and workflow UIs; `scripts/generate-workflow-pack.ts` generates shipped pack assets.
- `apps/observability`, `apps/review` — observability and review integrations.
- `docs` — Mintlify source; `skills` — agent skills; `examples` — runnable patterns; `e2e` — real-backend suites.
- `vendor/flows` — flows library vendored as tarballs under `@flows/*` until its alpha publishes; read `vendor/flows/README.md` before touching the aliases, overrides, or `.npmrc`.
- `package.json`, `pnpm-workspace.yaml` — command and workspace index.
- `apps/smithers*` and demo apps are POCs, not the product UI.

## Commands

```sh
pnpm install --frozen-lockfile
bun install --frozen-lockfile --offline --lockfile-only
pnpm typecheck
pnpm lint
pnpm -C packages/<package> test
pnpm test
pnpm -C e2e test
pnpm docs:llms                  # after docs changes

bun apps/cli/src/index.js <cmd>   # run smithers from this working tree
```

## Running smithers here

Internal scripts run the **working tree**, never an installed copy. `bunx
smthrs` downloads the published npm build; inside a checkout it
usually re-execs back into source via the published bin's `node_modules`
delegation, but a fresh worktree or slimmed checkout has no such install and
silently runs last release's build instead of the code under edit.

- Shell/npm scripts: `bun apps/cli/src/index.js <cmd>` (paths are repo-root relative).
- Plugin code: `resolveSmithersCli()` from `<plugin>/lib/resolve-smithers-cli.mjs`
  (copied verbatim into each plugin because Codex sparse-checkouts a plugin
  directory alone; `check:local-smithers` enforces the copies stay identical).
- Bare `smithers` is fine: `resolveSourceCheckoutCli` makes the bin delegate to
  this tree's `apps/cli/src/index.js` from anywhere inside the checkout.
- `pnpm check:local-smithers` (part of `pnpm test`) fails the build on a
  published-CLI invocation in an execution position. Prose mentions of `bunx
  smthrs` — agent prompts, docs assertions, marketing copy — are
  correct and are not flagged.

Running from source needs `pnpm install` and nothing else — every package
resolves through `src/`. Build steps only matter for these:

| Surface | Build first |
| --- | --- |
| `smithers ui --app` (bundled local UI) | none; the CLI vite-builds `apps/smithers` on demand and rebuilds when stale. `apps/cli/ui-dist` is a pack-time artifact and is only used when the source app cannot be built. |
| Types / `pnpm typecheck` / editor | `pnpm -r build` (`tsup --dts-only`) or `pnpm check:dts` |
| Vendored `jj` binaries | `pnpm fetch:jj` |
| Shipped init pack assets | `pnpm generate:init-pack` |

## Replies

- Be extremely concise. Minimum words to convey the point. Long replies go unread.
- Lead with the answer or result. No preamble, no recap of what you just did.
- Do the work instead of asking permission or listing options.

## Invariants

- Use `jj st`/`jj diff` for working-copy truth. Preserve unrelated concurrent changes; never blanket-stage.
- Dependency and package-manifest changes must refresh both `pnpm-lock.yaml` and `bun.lock` in the same commit.
- Product code and E2E tests use real backends/data, not mocked behavior.
- Keep public exports/types and generated docs bundles synchronized; root checks enforce both.
- Internal scripts execute this working tree's smithers, never an installed one (see above).
