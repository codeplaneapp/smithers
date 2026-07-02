# Docs pipeline and llms bundles

> **Status:** Fixed · **Priority:** P1 · **Owner:** smithers-maintainers · **Group:** Platform & delivery · **Tier:** Reference

**What you can do:** Humans and agents read the same current docs, bundled for LLM consumption.

Mintlify docs under docs/ with generated llms-*.txt bundles from a fixed manifest, gated in CI by check-docs and check-llms. Regenerate with pnpm docs:llms after editing docs.




## Test cases

- pnpm test (check-docs, check-llms gates)

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

