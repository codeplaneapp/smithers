# Open code review

> **Status:** Partial · **Priority:** P1 · **Owner:** smithers-maintainers · **Group:** Ship & review

**What you can do:** Run an agent review pass over any PR, locally or as a hosted service.

The open-code-review workflow backed by apps/review: reviews PRs with real agents, posts findings, and has a metered cloud deployment. Cloud path is blocked on funding the API key.




## Test cases

- pnpm -C .smithers test
- pnpm -C apps/review test

## Observability

_None recorded yet._

## Debugging

_None recorded yet._

## Architecture

_None recorded yet._

## Fixes & diffs

_None recorded yet._

## Open gaps

- Cloud deployment blocked on a funded ANTHROPIC_API_KEY

