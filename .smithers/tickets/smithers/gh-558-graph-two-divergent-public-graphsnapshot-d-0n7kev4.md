# 🧹 graph: two divergent public `GraphSnapshot` definitions (types.ts readonly vs GraphSnapshot.ts mutable)

GitHub: https://github.com/smithersai/smithers/issues/558

**What happens**
`packages/graph/src/types.ts:209-214` defines `GraphSnapshot` with readonly fields; `packages/graph/src/GraphSnapshot.ts` independently defines a *mutable* `GraphSnapshot` from the `XmlNode`/`TaskDescriptor` sidecars rather than re-exporting from `./types` like other sidecars. Both are public surface: the package exports `./*`, engine/smithers import `@smithers-orchestrator/graph/GraphSnapshot`, while `packages/driver` and `packages/components` deep-import `@smithers-orchestrator/graph/types`.

**Why it matters**
Two same-named types that can silently drift (readonly vs mutable already differ — a readonly array is not assignable to the mutable shape). `ExtractResult.ts` has the same pattern, redefining a mutable `WorkflowGraph` instead of reusing types.ts:203-207.

**Expected**
A single definition: sidecar re-exports from types.ts (or types.ts drops its copy), so the two cannot drift.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
