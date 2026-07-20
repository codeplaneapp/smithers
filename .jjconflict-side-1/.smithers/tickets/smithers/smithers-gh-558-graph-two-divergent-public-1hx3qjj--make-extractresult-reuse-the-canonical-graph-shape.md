# Make ExtractResult reuse the canonical graph shape

GitHub: https://github.com/smithersai/smithers/issues/989

Parent: smithers/gh-558-graph-two-divergent-public-graphsnapshot-d-0n7kev4.md

Context: packages/graph/src/ExtractResult.ts and its declaration independently define mutable xml, tasks, and mountedTaskIds fields instead of reusing the canonical graph types. Acceptance criteria: ExtractResult composes or re-exports a canonical type from types.ts for its graph fields while preserving mountedTaskIds; duplicate mutable graph-shape definitions are removed; generated declarations are updated; and a type-level regression test prevents future readonly/mutability drift.
