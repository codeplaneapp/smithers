# Agent memory

> **Status:** Partial | **Priority:** P2 | **Owner:** smithers-maintainers | **Group:** Author workflows

The memory package persists agent memories across runs so workflows can carry durable lessons between sessions.

## What you can do

Agents remember durable lessons from previous runs.

## Test cases

- `pnpm -C packages/memory test`

## Open gaps

- No end-to-end proof that seeded workflows read and write memory across separate runs
