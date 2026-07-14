# Smithers

Durable agent-workflow runtime/control plane. Product UI: `../multi`. Hosted forge: `../plue`.

`AGENTS.md` links here; edit this file.

## Find things

- `packages/{graph,scheduler,engine,driver}` — workflow graph, decisions, execution, task driving.
- `packages/{db,server,gateway,protocol,control-plane}` — persistence and control-plane contracts/services.
- `packages/{agents,sandbox,vcs,time-travel,memory,scorers,openapi}` — adapters and runtime capabilities.
- `packages/{gateway-client,gateway-react,gateway-ui,components,tui}` — gateway clients and run UIs.
- `packages/smithers` — published `smithers-orchestrator` facade; implement in the owning package, then export here.
- `apps/cli` — CLI, MCP server, gateway command, local workflow tools.
- `.smithers` — built-in/init workflow pack and workflow UIs; `scripts/generate-workflow-pack.ts` generates shipped pack assets.
- `apps/observability`, `apps/review` — observability and review integrations.
- `docs` — Mintlify source; `skills` — agent skills; `examples` — runnable patterns; `e2e` — real-backend suites.
- `package.json`, `pnpm-workspace.yaml` — command and workspace index.
- `apps/smithers*` and demo apps are POCs, not the product UI.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm -C packages/<package> test
pnpm test
pnpm -C e2e test
pnpm docs:llms                  # after docs changes
```

## Invariants

- Use `jj st`/`jj diff` for working-copy truth. Preserve unrelated concurrent changes; never blanket-stage.
- Product code and E2E tests use real backends/data, not mocked behavior.
- Keep public exports/types and generated docs bundles synchronized; root checks enforce both.
