# `@smithers-orchestrator/herdr`

Socket client + **run surface** that mirrors a Smithers run into a [herdr](https://herdr.dev)
workspace (presentation & steering plane). Soft-degradable: missing herdr never
fails the engine.

## Docs (where to look)

| Doc | What |
|---|---|
| [Integrations → Herdr](../../docs/integrations/herdr.mdx) | **Published** user guide (Mintlify) |
| [Design → cockpit](../../docs/design/herdr-cockpit.md) | Herdr placement: split, soft-pin, detail tabs, ops dock |
| [Design → overview HUD](../../docs/design/overview-hud.md) | **Portable** overview TUI: regions, fleet, aesthetics |
| [Design index](../../docs/design/README.md) | How design freezes relate to package + CLI |

The **overview HUD process** users run is `smithers tail --overview --hud` in
`apps/cli` (not this package alone). This package owns socket protocol, workspace
find-or-create, soft-pin policy, and pane commands.

## Install

Workspace package in the monorepo (`pnpm` / workspace protocol). Not a standalone
product UI — pair with the Smithers CLI and a running herdr server.
