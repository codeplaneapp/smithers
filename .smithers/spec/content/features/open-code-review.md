# Open code review

> **Status:** Partial | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Ship & review

The open-code-review workflow backed by `apps/review`: reviews PRs with real agents, posts findings, and has a metered cloud deployment. Cloud path is blocked on funding the API key.

## What you can do

Run an agent review pass over any PR, locally or as a hosted service.

## Test cases

- `pnpm -C .smithers test`
- `pnpm -C apps/review test`

## Open gaps

- Cloud deployment blocked on a funded ANTHROPIC\_API\_KEY
