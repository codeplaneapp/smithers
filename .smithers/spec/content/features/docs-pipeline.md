# Docs pipeline and llms bundles

> **Status:** Fixed | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Platform & delivery | **Tier:** Reference

Mintlify docs under docs/ with generated llms-\*.txt bundles from a fixed manifest, gated in CI by check-docs and check-llms. Regenerate with `pnpm docs:llms after editing docs`.

## What you can do

Humans and agents read the same current docs, bundled for LLM consumption.

## Test cases

- `pnpm test (check-docs`, check-llms gates)
