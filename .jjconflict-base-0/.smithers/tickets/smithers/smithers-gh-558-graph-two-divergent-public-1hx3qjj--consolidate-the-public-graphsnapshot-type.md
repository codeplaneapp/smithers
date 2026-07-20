# Consolidate the public GraphSnapshot type

GitHub: https://github.com/smithersai/smithers/issues/988

Parent: smithers/gh-558-graph-two-divergent-public-graphsnapshot-d-0n7kev4.md

Context: packages/graph/src/types.ts contains the canonical readonly GraphSnapshot, but packages/graph/src/GraphSnapshot.ts and its generated declaration independently define a mutable version. Acceptance criteria: GraphSnapshot has exactly one canonical definition; the GraphSnapshot sidecar re-exports that definition; top-level and deep imports resolve to the same readonly shape; generated declarations are updated; and a type-level regression test proves the two public import paths cannot drift.
