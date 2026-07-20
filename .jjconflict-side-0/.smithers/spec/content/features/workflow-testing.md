# Workflow testing and durability scenarios

> **Status:** Fixed | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Improve quality

Test workflows with scripted agents, in-memory simulation, prompt and frame rendering, single-task execution, Bun matchers, and a tiered durability scenario harness with real database and process adapters.

## What you can do

Catch graph, prompt, output, retry, crash, and replay regressions before running expensive live agents or deploying a workflow.

## Capabilities

### Simulation and fake agents

simulate and fakeAgent execute real workflow rendering with explicit scripted outputs and no accidental provider calls.

### Render and task helpers

renderWorkflow, renderPrompt, and runTask expose frames, descriptors, prompts, and isolated task execution.

### Durability scenarios

scenario, step, fault, barriers, cut points, and mediated effects model timing, crashes, ambiguity, and replay.

### Real capability tiers

Integration and e2e harnesses require executable database and process adapters and report unsupported capability instead of silently mocking it.

## Endpoints and commands

- `API simulate/fakeAgent` ([docs](docs/guides/testing-workflows.mdx))
- `API renderWorkflow/renderPrompt/runTask` ([docs](docs/guides/testing-workflows.mdx))
- `API runScenario` ([docs](docs/guides/testing-workflows.mdx))

## Related docs

- [Testing workflows](docs/guides/testing-workflows.mdx)

## Test cases

- `packages/testing/tests/simulate.test.ts`
- `packages/testing/tests/fakeAgent.test.ts`
- `packages/testing/tests/runtimeConformance.test.ts`
- `packages/testing/tests/replay-identity-fresh-process.test.ts`
- `e2e/testing-framework/real-db-integration.test.ts`
- `e2e/testing-framework/real-process-kill-resume.test.ts`
- `e2e/testing-framework/cutpoint-conformance.test.ts`

## Observability

- Scenario results include structured traces, control logs, capability reports, ambiguity records, replay identity, and determinism reports.
- Simulation records executed task ids, prompts, validated output rows, unused mocks, and final status for assertions.

## Debugging

- Start with renderWorkflow or simulate for prompt and graph failures, then move durability behavior to the scenario harness tier that owns the required capability.
- Use the replay bundle and first-divergence report to diagnose nondeterministic scenarios across fresh processes.

## Architecture

- `packages/testing` exports consumer-facing simulation, fake-agent, render, single-task, matcher, scenario, replay, and conformance APIs.
- Unit, integration, and e2e harnesses use virtual time, real database adapters, or real process adapters without representing mocks as production backends.

## Fixes and diffs

- 2026-07-18 feature and docs audit: added the complete workflow testing and durability scenario surface to the feature ledger and LLM bundle; the full package suite passed 144 tests.
- `packages/testing`
- `e2e/testing-framework`
- `docs/guides/testing-workflows.mdx`
