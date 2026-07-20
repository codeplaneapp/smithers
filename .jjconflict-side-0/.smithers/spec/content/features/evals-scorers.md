# Eval suites, scorers, and optimization

> **Status:** Partial | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Improve quality

The eval command runs workflows over `JSON/JSONL` cases, writes regression reports, scorers grade outputs and delegation runs, and optimize applies GEPA-style prompt patches from failed-case hints.

## What you can do

Protect important workflows with repeatable cases, score outputs, and optimize prompts against real run results.

## Capabilities

### Eval command

`smithers eval` plans stable run IDs, executes cases, checks `status/output/error` expectations, and writes JSON reports.

### Built-in scorers

Relevancy, toxicity, faithfulness, schema adherence, latency, LLM judge, and delegation-chain scorers are exported.

### Prompt optimization

`smithers optimize` builds provider optimizer calls, scores reports, and writes reusable optimization artifacts.

### Score persistence

smithersScorers table and listScores RPC expose stored score rows to UIs.

### LLM judge assertions

llmJudge and batch scorer helpers support rubric-based assertions with structured evidence and failure reporting.

### Cross-run comparison

listScoresForRuns and getScoreDetail let UIs compare scored runs without reconstructing rows client-side.

## Endpoints and commands

- `CLI smithers eval` ([docs](docs/guides/evals-quickstart.mdx))
- `CLI smithers optimize` ([docs](docs/cli/overview.mdx))
- `CLI smithers scores` ([docs](docs/cli/overview.mdx))
- `RPC listScores` ([docs](docs/rpc/list-scores.mdx))
- `API runScorersAsync` ([docs](docs/reference/scorers.mdx))
- `RPC listScoresForRuns` ([docs](docs/rpc/list-scores-for-runs.mdx))

## Related docs

- [Eval quickstart](docs/guides/evals-quickstart.mdx)
- [Scorers reference](docs/reference/scorers.mdx)
- [Eval author workflow](docs/workflows/eval-author.mdx)

## Test cases

- `apps/cli/tests/eval-suite.test.js`
- `apps/cli/tests/optimize-suite.test.js`
- `packages/scorers/tests/scorers-builtins-llm.test.js`
- `packages/scorers/tests/scorers-llm-judge-parse.test.js`
- `e2e/faults/case27-scorer-failure-blocks-downstream.test.ts`
- `packages/scorers/tests/scorers-builtins-llm.test.js`
- `packages/scorers/tests/scorers-llm-judge-parse.test.js`
- `packages/server/tests/gateway-score-rpcs.test.jsx`

## Observability

- Scorer metrics include scorersStarted, scorersFinished, scorersFailed, scorerDuration, and scorerEventsFailed.
- Eval reports preserve suite summary, per-case assertions, run IDs, inputs, outputs, errors, and report path.

## Debugging

- Run `smithers eval` <workflow> --cases <file> --suite <id> --dry-run to inspect planned IDs before launching.
- Use --no-include-output for `sensitive/large` outputs and --force only when intentionally replacing a report.

## Architecture

- `apps/cli/src/eval-suite.js` owns case loading, plan generation, assertion evaluation, and report writing.
- `packages/scorers/src/index.js` exports scorer factories, built-ins, delegation scoring, aggregation, cost estimation, schema, and metrics.
- `docs/guides/evals-quickstart.mdx` documents supported expected checks and production options.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- 2026-07-18 feature and docs audit: added LLM-judge assertions and score-comparison RPCs.
- `apps/cli/src/eval-suite.js`
- `apps/cli/src/optimize-suite.js`
- `packages/scorers/src`
- `docs/guides/evals-quickstart.mdx`
- `packages/scorers`

## Open gaps

- Optimizer tests prove helper behavior but production provider `quality/cost` needs suite-specific monitoring.
- More seeded workflows should ship checked-in eval suites for their intended behavior.
