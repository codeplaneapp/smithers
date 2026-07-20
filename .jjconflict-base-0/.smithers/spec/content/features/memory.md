# Agent memory

> **Status:** Partial | **Priority:** P2 | **Owner:** smithers-maintainers | **Group:** Remember context

Smithers provides local durable facts and threads plus declarative Memory and Task memory configuration for Hindsight-backed multi-bank recall, mental-model primers, agent memory tools, scoped tags, and asynchronous retention.

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

### Declarative task memory

Memory provides inherited banks, tags, recall mode, search budget, token cap, primers, retention, and remember or recall tools to descendant tasks.

### Hindsight backend

HINDSIGHT\_URL enables semantic multi-bank recall, mental-model primers, filtered tool access, and asynchronous retained task digests.

### Scoped recall

User and project banks apply stable branch, stream, source, and scope filters without mixing volatile run identity into tags.

## Endpoints and commands

- `API createMemoryStore` ([docs](docs/concepts/memory.mdx))
- `API createMemoryLayer` ([docs](docs/concepts/memory.mdx))
- `CLI smithers memory list|get|set|rm` ([docs](docs/cli/overview.mdx))
- `RPC listMemoryFacts` ([docs](docs/rpc/list-memory-facts.mdx))
- `API <Memory>` ([docs](docs/components/memory.mdx))

## Related docs

- [Memory concept](docs/concepts/memory.mdx)
- [Memory LLM fragment](docs/llms-memory.txt)
- [Memory component](docs/components/memory.mdx)
- [Memory reference](docs/reference/memory.mdx)

## Test cases

- `packages/memory/tests/store.test.js`
- `packages/memory/tests/service.test.js`
- `packages/memory/tests/processors.test.js`
- `packages/memory/tests/types.test.js`
- `apps/cli/tests/memory-cli.e2e.test.js`
- `packages/components/tests/memory-component.test.jsx`
- `packages/engine/tests/memory-runtime.test.jsx`
- `packages/memory/tests/hindsight-store.test.js`
- `packages/memory/tests/hindsight-docker.integration.test.js`
- `packages/memory/tests/local-memory-runtime.test.js`

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
- 2026-07-18 feature and docs audit: replaced the obsolete no-semantic-recall claim with the shipped Memory and Hindsight runtime, filters, primers, tools, and retention behavior; 32 focused component, engine, Hindsight, and local-runtime tests passed.
- `packages/memory/src`
- `packages/memory/tests`
- `apps/cli/src/index.js`
- `docs/concepts/memory.mdx`
- `packages/memory`
- `packages/components/src/components/Memory.js`
- `packages/engine/src/memory-runtime.js`

## Open gaps

- Separate HindsightMemoryStore writer instances do not share a durable same-document version fence; use one writer instance per transactional contract store.
- The real Hindsight Docker integration requires an external Postgres 15 or later service with pgvector and is not available in every CI environment.
