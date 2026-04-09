# Convert MemoryStore from closure factory to Effect Service/Layer

## Problem

`MemoryStore` in `src/memory/store.ts` is a plain object factory that captures
`db` via closure. The `db` dependency is not expressed as a `Context.Tag` +
`Layer`, forcing callers to construct the store imperatively and thread it
manually. Testing requires constructing real or mock DB instances — you cannot
swap the DB layer independently.

The dual Promise/Effect API surface (40+ methods duplicated) doubles maintenance
with no added type safety.

## Proposed solution

1. Define `SmithersDb` as a `Context.Tag` service
2. Convert `MemoryStore` to a `Layer` that depends on the `SmithersDb` service
3. Remove Promise wrapper methods — expose only Effect variants
4. Let callers compose via `Layer.provide`

## Severity

**MAJOR** — Affects testability and composability of the memory system.

## Files

- `src/memory/store.ts`
- `src/memory/service.ts`
- `src/memory/semantic.ts`
