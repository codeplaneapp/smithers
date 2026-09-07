/**
 * The generated flow catalog: `flows/catalog.json`.
 *
 * A repository's flows are discovered from `flows/` by the registry, and how
 * the repository presents them is declared in `PACKAGE.ts` with
 * {@link Flow.Flow}. Neither side alone is a listing a reader can trust
 * without running discovery: the Worker that serves smithers.sh reads the
 * public mirror and imports nothing, and a workspace without `node_modules`
 * cannot evaluate `PACKAGE.ts`. This target projects both into one checked-in
 * JSON file, the same way `ci.yml` and the root `tsconfig.json` are projected:
 * `write` renders it, `check` fails on drift, and the `lint` verb never
 * writes.
 *
 * The rendering itself is pure and lives here, so the shape of a catalog row
 * and the rules that order the rows are testable without a filesystem. The
 * discovery runs in the executor, which implements {@link FlowCatalogAction}
 * over the registry and hands this module the discovered flows.
 *
 * @since 1.0.0
 */
import { Action } from "@smthrs/flow"
import type * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Flow from "./Flow.ts"
import { DriftError, resolveOutputPath, WriteFileError } from "./GeneratedFile.ts"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

/**
 * The entry file a flow was discovered from: a `flow.ts` module, a
 * `flow.mdx` prompt, or a foreign `SKILL.md`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Kind = Schema.Literals(["ts", "mdx", "skill"])

/**
 * The entry file a flow was discovered from.
 *
 * @category models
 * @since 1.0.0
 */
export type Kind = typeof Kind.Type

/**
 * One flow as discovery reports it, reduced to what the catalog carries.
 *
 * `path` is workspace-relative and POSIX, so the same file renders the same
 * row on every host.
 *
 * @category schemas
 * @since 1.0.0
 */
export const DiscoveredFlow = Schema.Struct({
  id: Schema.NonEmptyString,
  description: Schema.String,
  kind: Kind,
  path: Schema.NonEmptyString,
  capabilities: Schema.Array(Schema.String),
  model: Schema.NullOr(Schema.String),
  modelInvocable: Schema.Boolean
})

/**
 * One flow as discovery reports it.
 *
 * @category models
 * @since 1.0.0
 */
export type DiscoveredFlow = typeof DiscoveredFlow.Type

/**
 * One catalog row: the discovered flow joined with its declaration.
 *
 * `summary` is `null` and `featured` is `false` for a flow no declaration
 * names, so a consumer reads every row the same way.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Row = Schema.Struct({
  id: Schema.NonEmptyString,
  description: Schema.String,
  summary: Schema.NullOr(Schema.String),
  featured: Schema.Boolean,
  kind: Kind,
  path: Schema.NonEmptyString,
  capabilities: Schema.Array(Schema.String),
  model: Schema.NullOr(Schema.String),
  modelInvocable: Schema.Boolean
})

/**
 * One catalog row.
 *
 * @category models
 * @since 1.0.0
 */
export type Row = typeof Row.Type

/**
 * The document `flows/catalog.json` holds.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Document = Schema.Struct({
  flows: Schema.Array(Row)
})

/**
 * The document `flows/catalog.json` holds.
 *
 * @category models
 * @since 1.0.0
 */
export type Document = typeof Document.Type

/**
 * The catalog could not be rendered: a declaration names no discovered flow,
 * two declarations name one flow, or the flows directory could not be read.
 *
 * @category errors
 * @since 1.0.0
 */
export class FlowCatalogError extends Schema.TaggedError<FlowCatalogError>()(
  "smithers-build/FlowCatalogError",
  {
    message: Schema.NonEmptyString
  }
) {}

/**
 * Output handling for the catalog. `check` is the default: only a target that
 * asks to `write`, or an executor run with `--write`, touches the file.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Mode = Schema.Literals(["write", "check"]).pipe(
  Schema.withConstructorDefault(Effect.succeed("check" as const))
)

/**
 * Output handling for the catalog.
 *
 * @category models
 * @since 1.0.0
 */
export type Mode = typeof Mode.Type

/**
 * Attributes for {@link FlowCatalog}.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Attrs = Schema.Struct({
  /** The workspace-relative directory discovery walks. @default "flows" */
  root: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("flows"))),
  /** The workspace-relative file the catalog is written to. @default "flows/catalog.json" */
  output: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("flows/catalog.json"))),
  /** The repository's flow declarations, in the order `PACKAGE.ts` states them. @default [] */
  flows: Schema.Array(Flow.Declaration).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Flow.Declaration>>([]))
  ),
  /** Whether to write the file or verify the checked-in copy. @default "check" */
  mode: Mode
})

/**
 * Attributes for {@link FlowCatalog}.
 *
 * @category models
 * @since 1.0.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Payload for one catalog rendering: where discovery walks, where the file
 * goes, the declarations to join, and whether to write or check.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Payload = Schema.Struct({
  root: Schema.NonEmptyString,
  output: Schema.NonEmptyString,
  flows: Schema.Array(Flow.Declaration),
  mode: Schema.Literals(["write", "check"])
})

/**
 * Payload for one catalog rendering.
 *
 * @category models
 * @since 1.0.0
 */
export type Payload = typeof Payload.Type

/**
 * Discovers the flows under `root`, joins the declarations, and writes or
 * checks the catalog file. Implemented by the executor, which owns the
 * registry's discovery.
 *
 * @category actions
 * @since 1.0.0
 */
export const FlowCatalogAction = Action.make("smithers-build/flow-catalog", {
  payload: Payload,
  error: Schema.Union([WriteFileError, DriftError, FlowCatalogError]),
  tier: "sealed"
})

/**
 * Joins the discovered flows with the declarations into catalog rows.
 *
 * Rows are ordered featured first, in declaration order; then the remaining
 * declared flows, in declaration order; then every other discovered flow by
 * id. A declaration that names no discovered flow, or a flow two declarations
 * name, is a failure carrying the id: a recommendation for a flow that does
 * not exist must never be written.
 *
 * @category constructors
 * @since 1.0.0
 */
export const rows = (
  discovered: ReadonlyArray<DiscoveredFlow>,
  declarations: ReadonlyArray<Flow.Declaration>
): ReadonlyArray<Row> => {
  const byId = new Map<string, DiscoveredFlow>()
  for (const flow of discovered) {
    if (byId.has(flow.id)) {
      throw new FlowCatalogError({ message: `discovery reported the flow ${JSON.stringify(flow.id)} twice` })
    }
    byId.set(flow.id, flow)
  }
  const declared = new Map<string, Flow.Declaration>()
  const unknown: Array<string> = []
  for (const declaration of declarations) {
    if (declared.has(declaration.flow)) {
      throw new FlowCatalogError({
        message: `PACKAGE.ts declares the flow ${JSON.stringify(declaration.flow)} twice`
      })
    }
    declared.set(declaration.flow, declaration)
    if (!byId.has(declaration.flow)) unknown.push(declaration.flow)
  }
  if (unknown.length > 0) {
    throw new FlowCatalogError({
      message: `PACKAGE.ts declares ${unknown.length === 1 ? "a flow" : "flows"} discovery did not find: ${
        unknown.map((id) => JSON.stringify(id)).join(", ")
      }`
    })
  }
  const row = (flow: DiscoveredFlow, declaration: Flow.Declaration | undefined): Row => ({
    id: flow.id,
    description: flow.description,
    summary: declaration?.summary ?? null,
    featured: declaration?.featured ?? false,
    kind: flow.kind,
    path: flow.path,
    capabilities: flow.capabilities,
    model: flow.model,
    modelInvocable: flow.modelInvocable
  })
  const featured: Array<Row> = []
  const declaredOnly: Array<Row> = []
  for (const declaration of declared.values()) {
    const built = row(byId.get(declaration.flow)!, declaration)
    if (declaration.featured) featured.push(built)
    else declaredOnly.push(built)
  }
  const rest = [...byId.values()]
    .filter((flow) => !declared.has(flow.id))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .map((flow) => row(flow, undefined))
  return [...featured, ...declaredOnly, ...rest]
}

/**
 * Renders the catalog document. Two-space indentation and a trailing newline,
 * so the checked-in file diffs like a hand-written one.
 *
 * @category rendering
 * @since 1.0.0
 */
export const render = (catalog: ReadonlyArray<Row>): string =>
  `${JSON.stringify(Schema.encodeSync(Document)({ flows: catalog }), null, 2)}\n`

/**
 * Reads a rendered catalog back, or reports why the text is not one.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parse = (text: string): Document | string => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    return `the catalog is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`
  }
  const decoded = Schema.decodeUnknownExit(Document)(value)
  return decoded._tag === "Success" ? decoded.value : "the catalog does not have the flows/catalog.json shape"
}

const entryGlobs = (root: string): ReadonlyArray<Input.Declared> =>
  ["flow.ts", "flow.mdx", "SKILL.md"].map((entry) => Input.glob(`//${resolveOutputPath(root)}/**/${entry}`))

/**
 * The generated flow catalog target.
 *
 * `check` is cacheable and keyed on the entry files discovery reads and on
 * the catalog itself, so editing a flow's frontmatter or the checked-in file
 * re-keys it. The `lint` verb maps `write` to `check`, so no lint or `ci` run
 * mutates the catalog; the executor's `--write` flips `check` to `write`.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const review = Smithers.Flow({ flow: "review", summary: "...", featured: true })
 * const flowCatalog = Smithers.FlowCatalog({ flows: [review] })
 * ```
 *
 * @category targets
 * @since 1.0.0
 */
export const FlowCatalog = Target.make("FlowCatalog", {
  attrs: Attrs,
  kinds: ["build", "lint"],
  error: Schema.Union([WriteFileError, DriftError, FlowCatalogError]),
  cache: (attrs) => attrs.mode !== "write",
  inputs: (attrs) =>
    attrs.mode === "write"
      ? entryGlobs(attrs.root)
      : [...entryGlobs(attrs.root), Input.file(`//${resolveOutputPath(attrs.output)}`)],
  outputs: (attrs) => ({ cwd: ".", paths: attrs.mode === "write" ? [resolveOutputPath(attrs.output)] : [] }),
  attrsForKind: (kind, attrs) =>
    kind === "lint" && attrs.mode === "write" ? { ...attrs, mode: "check" as const } : attrs,
  implementation: (
    attrs
  ): Node.Node<
    void,
    WriteFileError | DriftError | FlowCatalogError,
    Action.Requirement<"smithers-build/flow-catalog">
  > =>
    FlowCatalogAction.call({
      root: resolveOutputPath(attrs.root),
      output: resolveOutputPath(attrs.output),
      flows: attrs.flows,
      mode: attrs.mode
    })
})
