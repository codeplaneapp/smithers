# Custom workflow UIs (smithers ui)

> **Status:** Fixed | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Run & observe

Per-workflow custom UIs under `.smithers/ui/*.tsx` rendered through gateway-react and components packages, served by the `smithers ui` command with real-browser e2e harness support.

## What you can do

Give each workflow its own live dashboard without building a web app.

## Capabilities

### Gateway hooks

gateway-react hooks bind UI components to live run state.

### Seeded UIs

Init pack workflows ship pre-built UIs via generated ui sources.

## Test cases

- `pnpm -C packages/gateway-react test`
- `pnpm -C packages/components test`
