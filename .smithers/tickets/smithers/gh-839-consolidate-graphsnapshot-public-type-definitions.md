# Consolidate GraphSnapshot public type definitions

GitHub: https://github.com/smithersai/smithers/issues/839

Make packages/graph/src/GraphSnapshot.ts re-export the canonical readonly GraphSnapshot from types.ts, regenerate GraphSnapshot.d.ts, and add a type-level test proving the deep subpath and types.ts definitions cannot drift.
