# Targets and targets

A **target** is a callable definition. A **target** is what one call returns: a
flow with planner metadata attached.

## A target is a flow

`Target.make` builds an ordinary flows `Flow`:

- Its tag is the target id, for example `TsBuild`.
- Its payload schema is the target's attrs schema.
- Its success and error schemas are the target's declared channels.
- Its body is the target's implementation, a pure plan-time function of the decoded
  attrs.

The target call then attaches metadata under the symbol
`Symbol.for("smithers-build/Target")`, non-enumerable and non-writable. That
symbol is what makes the flow a target.

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
4. The flow is constructed and metadata attached. Dependencies and inputs are
   deduplicated, and `kinds` is deduplicated too.
5. `cacheable` is resolved: a boolean, or the result of `cache(attrs)`, defaulting
   to `true`.
6. `sourceFile` is captured by scanning the construction stack for a `PACKAGE.ts`
   frame.

No filesystem read, no process spawn, and no await happens anywhere in that
sequence.

## Target identity

A target's id is its flow tag and its `target` metadata field. It appears in key
material, in query and graph output, and in the planner's layer and capability
tables.

Two targets of the same target share the flow tag. That is why the executor gives
each target a fresh in-memory runtime: registering both with one engine would
alias their bodies. `API-REVIEW.md` records this as open question 1.

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

A target becomes addressable when a `PACKAGE.ts` file exports it under a name.
Discovery walks the module namespace in ascending export-name order and sorts
each export into one of three buckets:

| Value                           | Effect                                          |
| ------------------------------- | ----------------------------------------------- |
| A target                        | Registered under `//<packagePath>:<exportName>` |
| A `PackageDefaults` declaration | Recorded with the declaring package path        |
| A `Workspace` declaration       | Read by configuration resolution                |

Everything else is ignored, including a `file()` value exported for other
`PACKAGE.ts` files to import.

Exporting one target value under two names fails with
`one target value is exported under both <a> and <b>`. A target call is what
creates a target, so two calls with identical attributes produce two distinct
values and two distinct labels.

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
- [Writing targets](../extending/writing-targets.md)
