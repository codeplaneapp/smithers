# Custom workflow UIs (smithers ui)

> **Status:** Fixed · **Priority:** P1 · **Owner:** smithers-maintainers · **Group:** Run & observe

**What you can do:** Give each workflow its own live dashboard without building a web app.

Per-workflow custom UIs under .smithers/ui/*.tsx rendered through gateway-react and components packages, served by the smithers ui command with real-browser e2e harness support.

## Capabilities

### Gateway hooks

gateway-react hooks bind UI components to live run state.

### Seeded UIs

Init pack workflows ship pre-built UIs via generated ui sources.




## Test cases

- pnpm -C packages/gateway-react test
- pnpm -C packages/components test

## Observability

_None recorded yet._

## Debugging

_None recorded yet._

## Architecture

_None recorded yet._

## Fixes & diffs

_None recorded yet._

## Open gaps

_None recorded yet._

