# Fixture: `batch-issues`

A Smithers 0.x workflow pack that depends on the facade by its bare directory name. The pack lives inside the old monorepo's parent tree, so its manifest reads `"smithers": "file:../../../../smithers"` and every module imports from `"smithers"` rather than `smthrs` or `smithers-orchestrator`. The factory is split out: `smithers.ts` calls `createSmithers` once and re-exports `Workflow`, `Task`, `useCtx`, `smithers`, `tables`, and `outputs`, and all thirteen components import them from there.

Origin: `/Users/williamcory/plue/.smithers/workflows/batch-issues` at Plue commit `2db1ecff21f7da8101f466570a6b997285eae394` (2026-08-28).

| Fixture path | Origin path |
| --- | --- |
| `.smithers/workflows/batch-issues/**` | `.smithers/workflows/batch-issues/**` |

Omitted, and nothing else:

- `node_modules/`, which is an install output.
- `pnpm-lock.yaml`, 82 KB of resolved third-party versions that no rule in this package reads. `plue-pack` and `jsx-single` cover lockfile detection.

Authored, because the origin repository holds it outside the pack:

- `package.json`: the workspace root, with the `smithers-orchestrator` devDependency and the `smithers up` script the origin root carries.

What this fixture proves that the others do not:

- The bare `smithers` package name counts as the old facade when its spec is a `file:` link, and its import specifier counts with it.
- A manifest in a directory that holds a workflow file is `workflow-adjacent`, not another workspace member.
- Factory bindings resolve across a re-export module, so a pack that never calls `createSmithers` in a workflow file still inventories its constructs.
- `outputs.<key>` (13 reads) and `tables.<key>` (30 reads) are recorded as member access on those bindings. `smithers.ts` also re-exports `useCtx`, which no module in the pack calls.
