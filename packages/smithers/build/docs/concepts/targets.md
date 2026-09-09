---
title: "Target definitions and targets"
description: "What a target definition is, what a target call returns, and the metadata that turns a flow into a node of the build graph."
---

A **target definition** is callable. A **target** is the opaque declaration that
one call returns. Its attributes, dependency edges, schemas, and declared outputs
belong to the package build graph.

## Declaration and execution

`Target.make` creates a target without Flow execution methods. Run declarations
through the package executor, which resolves tools, dependencies, workspace
configuration, and catalog-specific execution.

`Target.plan(target)` explicitly lowers the declaration's action implementation
to a plan node. A host may embed an action-backed declaration in a Flow with
`body: () => Target.plan(target)`. This does not resolve package dependencies or
make package-only catalog rules executable by a bare Flow runtime: those rules
lower to their typed `NotImplemented` action.

The target carries metadata under `Symbol.for("smithers-build/Target")`,
non-enumerable and non-writable. Its `_tag` preserves the declared id used in
existing cache material.

```ts
interface Metadata {
  readonly target: string
  readonly kinds: ReadonlyArray<Kind>
  readonly attrs: unknown
  readonly attrsSchema: Flow.AnyStructSchema
  readonly dependencies: ReadonlyArray<AnyTarget>
  readonly inputs: ReadonlyArray<Input.Declared>
  readonly cacheable: boolean
  readonly sourceFile: string | undefined
  readonly forKind: (kind: Kind) => KindView
}

interface KindView {
  readonly attrs: unknown
  readonly inputs: ReadonlyArray<Input.Declared>
  readonly cacheable: boolean
}
```

`Target.isTarget(value)` tests for the symbol. `Target.metadata(target)` reads it.

`attrs`, `inputs`, and `cacheable` are the declared view. `forKind(verb)` is the
view one verb executes with; see [Verb-effective attrs](#verb-effective-attrs).

## What a target call does

Calling a target is pure. In order:

1. `options.attrs.make(input)` decodes the attributes and applies constructor
   defaults, so `cwd` becomes `"."` when omitted and `dryRun` becomes `true` on
   the publish targets.
2. The decoded attrs are walked recursively, through arrays and plain objects at
   any depth, with a visited set for cycles. Every target found becomes a
   dependency; every declared input found becomes an input.
3. The target's optional `inputs(attrs)` function contributes further declared
   inputs. `PnpmWorkspace` uses this to declare its lockfile and manifests;
   `PackageJsonCheck` and `GithubCiGen` use it to declare their output file in
   check mode.
4. The declaration is constructed and metadata attached. Dependencies and inputs are
   deduplicated, and `kinds` is deduplicated too.
5. `cacheable` is resolved: a boolean, or the result of `cache(attrs)`, defaulting
   to `false`. See the [cache opt-in contract](../workspace/caching.md#cacheability).
6. `sourceFile` is captured by scanning the construction stack for a `PACKAGE.ts`
   frame.

No filesystem read, no process spawn, and no await happens anywhere in that
sequence.

## Target identity

A target's id is its `_tag` and its `target` metadata field. It appears in cache
material, query and graph output, and planner capability tables. Multiple targets
may use one definition and id; the package label and decoded attributes identify
the individual graph nodes. Hosts lowering targets into flows choose their own
flow registration and execution identities explicitly.

## Kinds

`Target.Kind` is `"build" | "test" | "lint" | "run" | "docs"`. A target declares
the verbs its targets participate in.

```ts
const buildKinds = ["build"] // TsBuild
const generatedKinds = ["build", "lint"] // SortPackageJson, GithubCiGen
const runKinds = ["run"] // PnpmWorkspace, Clean, Dev, Changesets, publishes
const docsKinds = ["docs"] // DocsParity
```

The `run` verb executes explicitly selected run targets, including source-tree
writes such as `PackageJsonWrite`. See [Running targets](../workspace/running-targets.md).

## Verb-effective attrs

A target that declares several kinds can execute a different form under each one.
The optional `attrsForKind(kind, attrs)` option maps the declared attrs to what
that verb runs with.

`GithubCiGen` uses it to map `lint` to its drift-check form:

```ts
const attrsForKind = (kind, attrs) =>
  kind === "lint" && attrs.mode !== "check" ? { ...attrs, mode: "check" as const } : attrs
```

`PackageJson` instead synthesizes separate check, write, and refresh targets.

`Metadata.forKind(kind)` resolves the mapping. A target without an `attrsForKind`
option returns the declared view for every verb. A target with one that actually
changes the attrs gets re-derived declared inputs and re-evaluated cacheability
for the mapped value, so a `lint` plan of a generator declares its output file as
an input and is cacheable, while the `build` plan of the same target does
neither.

Dependencies never vary by verb. Only attrs, declared inputs, and cacheability do.

The planner calls `forKind(verb)` for every execution verb (`build`, `test`,
`lint`, `run`, and `docs`) and uses the declared view for `graph` and `query`.
Because key material is built from the resolved view, one target can have two
different content keys, one per verb. The executor passes the same resolved
attrs to the flow.

## Export discovery

A `PACKAGE.ts` file must export exactly one `Smithers.Package` declaration named
`Package`. Its `targets` map makes targets addressable; map keys, not module
export names, determine labels.

```ts
import { Smithers } from "@smthrs/targets"

const sources = Smithers.Filegroup({ srcs: [Smithers.glob("src/**/*.ts")] })

export const Package = Smithers.Package({
  targets: { sources }
})
```

Discovery reads the map keys in ascending order and registers each target as
`//<packagePath>:<targetKey>`. For example, the declaration above in
`packages/greeter/PACKAGE.ts` registers `//packages/greeter:sources`. Another
package can import `Package` and refer to `Package.sources`.

A top-level target export fails with `naked_target_export`, even when the same
target is also in the map. A missing `Package` export fails with
`package_export_missing`; a Package declaration exported under another name
fails with `invalid_package_export`.

Shared non-target values, such as runtime and package-manager declarations or
`file()` inputs, may remain named exports. They do not acquire target labels
from those exports. Workspace configuration belongs in `WORKSPACE.ts`.

Listing the same target value under two map keys fails with
`target_multiple_labels`. Use `Smithers.Alias` for a second name, or make two
separate target calls to create distinct values and labels.

## Success and error channels

A target declares both channels as schemas. They default to `Schema.Void` and
`Schema.Never`.

| Channel | Typical value                                                                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Success | `Exec.Result` for a single tool run, `Outputs` for a producing build, a target-specific struct for a multi-run target                                           |
| Error   | `Exec.ExecError` for tool runs, a `WriteFileError` or `DriftError` union for generators, `ReviewError` for `LlmLint`, `PackageManagerError` for `PnpmWorkspace` |

The success value is what the result cache stores, clamped to what JSON can hold.

## Not-implemented stubs

`@smthrs/targets` ships machinery for catalog stubs: a `NotImplemented` tagged
error, a sealed `smithers-build/not-implemented` action, `Target.notImplemented(id)`
to plan a stub node, and `Target.layerNotImplemented` to turn that node into the
typed failure.

**No target in the current catalog uses it.** Every catalog target has a real
implementation. The machinery remains for future catalog additions, and the
executor keeps the layer in scope so a stub would fail cleanly rather than refuse
to interpret.

That is not the same as saying every target runs today. Several targets call actions
whose implementations the CLI executor does not provide. See
[Running targets](../workspace/running-targets.md#what-executes).

## Next

- [Inputs](inputs.md)
- [Dependencies](dependencies.md)
- [Writing target definitions](../extending/writing-targets.md)
