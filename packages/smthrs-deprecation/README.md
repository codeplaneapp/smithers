# smthrs

`smthrs@1.0.0-rc.0` is a migration notice, not a runtime. Importing it throws:

```
smthrs 1.0 is a migration notice, not a runtime.
Smithers 1.0 ships as @smthrs/* packages. Install @smthrs/flows (authoring and engine)
and @smthrs/cli (the `smithers` command), then run `smithers migrate` in a 0.x project.
Migration guide: https://smithers.sh/migration/1.0
```

## Migrate

Read the [migration guide](https://smithers.sh/migration/1.0), then:

```sh
npm remove smthrs
npm install @smthrs/flows@1.0.0-rc.0 @smthrs/cli@1.0.0-rc.0
npx smithers migrate
```

`@smthrs/flows` is the curated aggregate: authoring primitives, the engine, and
the durable stores. `@smthrs/cli` owns the `smithers` command. Import the
`@smthrs/*` package you need directly; there is no umbrella package at 1.0.

## `ERR_PACKAGE_PATH_NOT_EXPORTED` instead of the notice

Only the root specifier `smthrs` throws the notice. Every 0.x subpath fails to
resolve at all, with the message Node prints for a subpath a package does not
export:

```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './jsx-runtime' is not defined by "exports" in .../node_modules/smthrs/package.json
```

`smthrs/jsx-runtime` and `smthrs/jsx-dev-runtime` are the two a 0.x project hits
first, because `jsxImportSource: "smthrs"` makes every `.tsx` file resolve one
of them before anything imports the bare name. `smthrs/ui`, `smthrs/gateway-react`,
and the rest of the 0.x subpaths fail the same way. The failure means what the
notice means: 1.0 publishes no JSX runtime and no umbrella subpaths, so there is
nothing behind those specifiers to import. The fix is the same too, `npm remove
smthrs` and the migration above; `@smthrs/migrate` rewrites the imports and drops
the `jsxImportSource` setting for you.

## What this package used to export, and what replaces it

Smithers 0.x published `smthrs` as an umbrella facade over the JSX authoring
API and fourteen `@smthrs/*` packages. Smithers 1.0 replaces that architecture
with the `Flow`, `Action`, `Node`, and Effect APIs. Nothing in the table below
has a source-compatible replacement; each row names the concept to rewrite
against.

| Removed from `smthrs`                                                     | Replacement in 1.0                                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `smthrs/jsx-runtime`, `smthrs/jsx-dev-runtime`, `@jsxImportSource smthrs` | No JSX authoring API. Author flows in TypeScript with `Flow` and `Action` from `@smthrs/flow`.      |
| `Workflow` and `Task` components                                          | `Flow.make` and `Action.make` (`@smthrs/flow`), composed as a graph.                                |
| `Sequence`, `Parallel`, `Branch` components                               | `Node.andThen`, `Node.all`, `Node.branch` (`@smthrs/core`).                                         |
| `Loop`, `Ralph`, `ReviewLoop` components                                  | `ReviewLoop.run`, or `Recursion.recurse` with explicit fuel (`@smthrs/patterns`).                   |
| `SmithersRenderer`, `createSmithers`, `runWorkflow`, the React reconciler | `FlowEngine` and `FlowProxy` (`@smthrs/engine`), composed through `@smthrs/flows/NodeRuntime`.      |
| `Approval`, `HumanTask`, `Wait`, `Signal` components                      | Durable deferreds, signals, and approvals on the control plane (`@smthrs/flow`, `@smthrs/control`). |
| Output accessors and workflow context hooks                               | Journal projections and the run store (`@smthrs/journal`, `@smthrs/run-store`).                     |
| `mdx-plugin`, JSX workflow loaders and templates                          | Flow descriptor discovery (`@smthrs/registry`).                                                     |
| Backend selection and direct database helpers                             | `@smthrs/database` and `@smthrs/engine-store`. SQLite is the only backend supported at 1.0.0-rc.0.  |
| The `smithers` binary published by `smthrs`                               | `@smthrs/cli`, which owns the `smithers` binary at 1.0.                                             |

Smithers 1.0.0-rc.0 does not migrate live or in-flight 0.x runs. Finish,
archive, or discard them before upgrading.

`smthrs@0.35.0` stays on the `latest` dist-tag until Smithers 1.0.0 is final.
Release candidates publish under the `next` dist-tag.
