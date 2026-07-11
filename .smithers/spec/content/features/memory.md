# Agent memory

> **Status:** Partial | **Priority:** P2 | **Owner:** smithers-maintainers | **Group:** Remember context

The memory package persists namespaced facts, threads, and messages, provides Effect service layers, `TTL/token/summarizer` processors, metrics, a CLI, and Gateway memory fact listings.

## What you can do

Carry durable lessons, facts, and conversation history between workflow runs without hard-coding context into prompts.

## Capabilities

### Working memory facts

`set/get/delete/list` facts by workflow, agent, user, or global namespace with TTL support.

### Threaded messages

createThread, saveMessage, listMessages, countMessages, and deleteThread persist conversation history.

### Processors

TtlGarbageCollector removes expired facts, TokenLimiter trims old messages, and Summarizer condenses history without data-loss windows.

### CLI and Gateway read paths

`smithers memory` commands and listMemoryFacts expose memory to operators and UIs.

## Endpoints and commands

- `API createMemoryStore` ([docs](docs/concepts/memory.mdx))
- `API createMemoryLayer` ([docs](docs/concepts/memory.mdx))
- `CLI smithers memory list|get|set|rm` ([docs](docs/cli/overview.mdx))
- `RPC listMemoryFacts` ([docs](docs/rpc/list-memory-facts.mdx))

## Related docs

- [Memory concept](docs/concepts/memory.mdx)
- [Memory LLM fragment](docs/llms-memory.txt)

## Test cases

- `packages/memory/tests/store.test.js`
- `packages/memory/tests/service.test.js`
- `packages/memory/tests/processors.test.js`
- `packages/memory/tests/types.test.js`
- `apps/cli/tests/memory-cli.e2e.test.js`

## Observability

- Memory metrics include memoryFactReads, memoryFactWrites, memoryRecallQueries, memoryMessageSaves, and memoryRecallDuration.
- Gateway and CLI memory listings expose persisted fact rows for operator inspection.

## Debugging

- Use `smithers memory list` --format json to inspect namespaces and fact values without entering the database directly.
- Run memory processor tests when changing summarization or token trimming to avoid data-loss windows.

## Architecture

- `packages/memory/src/index.js` exports schema, createMemoryStore, processors, MemoryService, createMemoryLayer, namespace codecs, and metrics.
- `docs/concepts/memory.mdx` and `docs/llms-memory.txt` are the `human/agent` references.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- `packages/memory/src`
- `packages/memory/tests`
- `apps/cli/src/index.js` memoryCli
- `docs/concepts/memory.mdx`

## Open gaps

- No end-to-end proof that seeded workflows read and write memory across separate real runs.
- Semantic recall is intentionally not exposed on the current public API; keep docs clear to avoid overpromising retrieval behavior.
