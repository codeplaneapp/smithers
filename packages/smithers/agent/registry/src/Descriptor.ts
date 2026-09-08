/**
 * Serializable flow-registry descriptors.
 *
 * Governing contract: `packages/smithers/agent/registry/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/registry.
 * `EffectDeclaration` is the fully explicit discovery projection of
 * `packages/smithers/flows/core/src/Effects.ts`; placement literals are lowered by
 * `packages/smithers/flows/core/src/Markdown.ts` into `packages/smithers/flows/core/src/Placement.ts`
 * values. The adapter is implemented by `MarkdownFlow.toCoreFrontmatter`.
 *
 * @since 0.1.0
 */
import * as Digest from "@smthrs/core/Digest"
import { Schema } from "effect"

/**
 * The reversibility tier declared by a flow.
 *
 * @category models
 * @since 0.1.0
 */
export const EffectTier = Schema.Literals(["sealed", "compensable", "irreversible"])

/**
 * The reversibility tier declared by a flow.
 *
 * @category models
 * @since 0.1.0
 */
export type EffectTier = typeof EffectTier.Type

/**
 * The execution environment selected by a leading placement directive.
 *
 * @category models
 * @since 0.1.0
 */
export const Placement = Schema.Literals(["client", "local", "sandbox", "remote"])

/**
 * The execution environment selected by a leading placement directive.
 *
 * @category models
 * @since 0.1.0
 */
export type Placement = typeof Placement.Type

/**
 * The canonical effect declaration shared with `/core`.
 *
 * @category models
 * @since 0.1.0
 */
export const EffectDeclaration = Schema.Struct({
  reads: Schema.Array(Schema.String),
  writes: Schema.Array(Schema.String),
  mode: Schema.Literals(["hermetic", "expected"]),
  onConflict: Schema.Literals(["serialize", "lane", "fail"]),
  tier: EffectTier
})

/**
 * The canonical effect declaration shared with `/core`.
 *
 * @category models
 * @since 0.1.0
 */
export type EffectDeclaration = typeof EffectDeclaration.Type

/**
 * The fixed `{ args: string }` input marker used by markdown flows.
 *
 * @category models
 * @since 0.1.0
 */
export class SchemaRefMarkdownArgs
  extends Schema.TaggedClass<SchemaRefMarkdownArgs>("flows/registry/SchemaRef/MarkdownArgs")(
    "MarkdownArgs",
    {}
  )
{}

/**
 * The fixed string output marker used by markdown flows.
 *
 * @category models
 * @since 0.1.0
 */
export class SchemaRefMarkdownOutput
  extends Schema.TaggedClass<SchemaRefMarkdownOutput>("flows/registry/SchemaRef/MarkdownOutput")(
    "MarkdownOutput",
    {}
  )
{}

/**
 * A schema field on a module's default `Flow.make` value. Discovery records
 * the field location without evaluating the module.
 *
 * @category models
 * @since 0.1.0
 */
export class SchemaRefModule extends Schema.TaggedClass<SchemaRefModule>("flows/registry/SchemaRef/Module")("Module", {
  path: Schema.String,
  field: Schema.Literals(["input", "output"])
}) {}

/**
 * A flow with no declared input or output schema.
 *
 * @category models
 * @since 0.1.0
 */
export class SchemaRefNone extends Schema.TaggedClass<SchemaRefNone>("flows/registry/SchemaRef/None")("None", {}) {}

/**
 * A schema carried by value, as a JSON Schema document.
 *
 * The other three variants are *locators*: they say where a schema lives so
 * discovery can record it without evaluating the module that defines it. A
 * host that binds a declaration it already holds — `@smthrs/harness`'s
 * `FlowBinding` — has the schema itself and nothing to locate, and a locator
 * pointing at a synthetic `binding://` path is unreadable by anything
 * downstream. That is what left `ctx.flows` describing every standard flow by
 * name, tier, and prose alone: a cell had to guess `command` versus `cmd`,
 * then discover `reads` and `writes` one rejected frame at a time.
 *
 * The document is `Schema.toJsonSchemaDocument` output, kept as plain JSON so
 * a descriptor stays serializable and comparable.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export class SchemaRefInline extends Schema.TaggedClass<SchemaRefInline>("flows/registry/SchemaRef/Inline")(
  "Inline",
  { document: Schema.Json }
) {}

/**
 * A serializable locator for a flow input or output schema.
 *
 * @category models
 * @since 0.1.0
 */
export const SchemaRef = Schema.Union([
  SchemaRefMarkdownArgs,
  SchemaRefMarkdownOutput,
  SchemaRefModule,
  SchemaRefNone,
  SchemaRefInline
])

/**
 * A serializable locator for a flow input or output schema.
 *
 * @category models
 * @since 0.1.0
 */
export type SchemaRef = typeof SchemaRef.Type

/**
 * A markdown body stored at a source path.
 *
 * @category models
 * @since 0.1.0
 */
export class BodyRefMarkdown
  extends Schema.TaggedClass<BodyRefMarkdown>("flows/registry/BodyRef/Markdown")("Markdown", {
    path: Schema.String,
    baseDirectory: Schema.String,
    /**
     * SHA-256 of the complete source bytes measured during discovery.
     *
     * Optional only so descriptors journaled before rc.0 still decode. Every
     * current discovery and executable-binding constructor supplies it.
     * Registry.loadBody and Executable.fromDescriptor refuse it when absent.
     */
    contentDigest: Schema.optional(
      Schema.String.check(
        Schema.isPattern(/^[0-9a-f]{64}$/, {
          expected: "a 64-character lowercase hexadecimal SHA-256 digest"
        })
      )
    )
  })
{}

/**
 * A module body stored at a source path.
 *
 * @category models
 * @since 0.1.0
 */
export class BodyRefModule extends Schema.TaggedClass<BodyRefModule>("flows/registry/BodyRef/Module")("Module", {
  path: Schema.String,
  /**
   * SHA-256 of the complete module source bytes measured during discovery.
   * Optional for older journaled descriptors to decode; Registry.loadBody and
   * Executable.fromDescriptor refuse an absent digest with body_unavailable.
   */
  contentDigest: Schema.optional(
    Schema.String.check(
      Schema.isPattern(/^[0-9a-f]{64}$/, {
        expected: "a 64-character lowercase hexadecimal SHA-256 digest"
      })
    )
  )
}) {}

/**
 * A serializable locator and content address for a flow body, which is loaded
 * only on demand.
 *
 * @category models
 * @since 0.1.0
 */
export const BodyRef = Schema.Union([BodyRefMarkdown, BodyRefModule])

/**
 * A serializable locator and content address for a flow body, which is loaded
 * only on demand.
 *
 * @category models
 * @since 0.1.0
 */
export type BodyRef = typeof BodyRef.Type

/**
 * A loaded markdown prompt body.
 *
 * @category models
 * @since 0.1.0
 */
export class FlowBodyPrompt extends Schema.TaggedClass<FlowBodyPrompt>("flows/registry/FlowBody/Prompt")("Prompt", {
  text: Schema.String,
  baseDirectory: Schema.String
}) {}

/**
 * A loaded module flow body.
 *
 * @category models
 * @since 0.1.0
 */
export class FlowBodyModule extends Schema.TaggedClass<FlowBodyModule>("flows/registry/FlowBody/Module")("Module", {
  path: Schema.String
}) {}

/**
 * The body returned after an entry is loaded on demand.
 *
 * @category models
 * @since 0.1.0
 */
export const FlowBody = Schema.Union([FlowBodyPrompt, FlowBodyModule])

/**
 * The body returned after an entry is loaded on demand.
 *
 * @category models
 * @since 0.1.0
 */
export type FlowBody = typeof FlowBody.Type

/**
 * The pack a descriptor was discovered in, when it came from one.
 *
 * `origin` is what decided a name collision: a `local` pack shadows an
 * `installed` one, so an operator reading a descriptor can tell which half of
 * the merge it survived.
 *
 * @category models
 * @since 0.1.0
 */
export const PackRef = Schema.Struct({
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  origin: Schema.Literals(["local", "installed"])
})

/**
 * The pack a descriptor was discovered in.
 *
 * @category models
 * @since 0.1.0
 */
export type PackRef = typeof PackRef.Type

/**
 * Opaque source information retained with each discovered entry.
 *
 * `pack` is absent for a descriptor discovered from a plain source, which is
 * every source the single-source registry scans. It is present only when a
 * pack manifest named the directory the entry was found in.
 *
 * @category models
 * @since 0.1.0
 */
export class Provenance extends Schema.Class<Provenance>("flows/registry/Provenance")({
  source: Schema.String,
  root: Schema.String,
  pack: Schema.optional(PackRef)
}) {}

/**
 * Registry source configuration. `source` is opaque caller-supplied metadata.
 *
 * @category models
 * @since 0.1.0
 */
export interface Source {
  readonly source: string
  readonly root: string
  readonly naming: "path" | "frontmatter"
  readonly system?: boolean | undefined
}

/**
 * Stable codes for non-fatal source-discovery diagnostics.
 *
 * @category models
 * @since 0.1.0
 */
export const DiscoveryWarningCode = Schema.Literals([
  "missing_description",
  "invalid_description",
  "missing_name",
  "invalid_name",
  "directory_name_mismatch",
  "name_field_ignored",
  "unknown_frontmatter_key",
  "unknown_pack_key",
  "invalid_allowed_tools",
  "invalid_capabilities",
  "invalid_budget",
  "unprojectable_authority",
  "invalid_model_invocation",
  "invalid_compatibility",
  "invalid_license",
  "invalid_metadata",
  "non_serializable_frontmatter",
  "invalid_effect_declaration",
  "invalid_effect_tier",
  "unsupported_input_schema",
  "unsupported_module_metadata",
  "multiple_entry_files",
  "duplicate_name",
  "frontmatter_parse_error",
  "root_level_entry",
  "shadowed",
  "symlink_cycle",
  "max_depth_exceeded",
  "entry_too_large",
  "unreadable"
])

/**
 * Stable codes for non-fatal source-discovery diagnostics.
 *
 * @category models
 * @since 0.1.0
 */
export type DiscoveryWarningCode = typeof DiscoveryWarningCode.Type

/**
 * A non-fatal source-discovery diagnostic.
 *
 * @category models
 * @since 0.1.0
 */
export class DiscoveryWarning extends Schema.Class<DiscoveryWarning>("flows/registry/DiscoveryWarning")({
  code: DiscoveryWarningCode,
  path: Schema.String,
  name: Schema.optional(Schema.String),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * A positive safe-integer control-plane budget ceiling.
 *
 * Tokens are indivisible, and millisecond envelopes use the same finite,
 * lossless representation so both fields survive durable JSON unchanged.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BudgetCeiling = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * A positive safe-integer control-plane budget ceiling.
 *
 * @category models
 * @since 0.1.0
 */
export type BudgetCeiling = typeof BudgetCeiling.Type

/**
 * The tokens and milliseconds a flow declares that a control plane should
 * approve for one of its runs.
 *
 * Both ceilings are positive safe integers. The two fields are projected into
 * a control-plane `Envelope.budget` without reinterpretation, and
 * `@smthrs/agent` enforces them at the model boundary.
 *
 * An absent field is not a zero. It is the absence of that ceiling, which is
 * what {@link budgetUnbounded} spells out for a flow that declares neither.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const FlowBudget = Schema.Struct({
  tokens: Schema.optional(BudgetCeiling),
  milliseconds: Schema.optional(BudgetCeiling)
})

/**
 * The tokens and milliseconds a flow declares.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type FlowBudget = typeof FlowBudget.Type

/**
 * The budget of a flow that declares none: no token ceiling and no latency
 * ceiling.
 *
 * It is a named value rather than a `{}` written at each host for the reason
 * `@smthrs/agent`'s `Budget.layerUnbounded` is a named layer rather than an
 * omitted service: giving up spending enforcement is a decision, and a reader
 * has to be able to see that a host made it. A host that projects this into an
 * envelope has decided the flow may spend what it likes.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const budgetUnbounded: FlowBudget = Object.freeze({})

/**
 * The discovered metadata for one flow, excluding its unloaded body content.
 *
 * `budget` is absent for a flow that declares none, and {@link budgetOf} is how
 * a host reads it, so the absence is answered with {@link budgetUnbounded}
 * rather than with an empty object nobody named.
 *
 * @category models
 * @since 0.1.0
 */
export class FlowDescriptor extends Schema.Class<FlowDescriptor>("flows/registry/FlowDescriptor")({
  name: Schema.String,
  description: Schema.String,
  body: BodyRef,
  input: SchemaRef,
  output: SchemaRef,
  model: Schema.Option(Schema.String),
  flows: Schema.Array(Schema.String),
  capabilities: Schema.Array(Schema.String),
  effects: EffectDeclaration,
  placement: Schema.Option(Placement),
  modelInvocable: Schema.Boolean,
  budget: Schema.optional(FlowBudget),
  path: Schema.String,
  frontmatter: Schema.Record(Schema.String, Schema.Json),
  provenance: Provenance
}) {}

/**
 * The executable identity a host binds into a reviewed plan.
 *
 * Includes the complete source digest and all discovered metadata, so changing
 * the model, parameters, body location, or authority cannot reuse an approval.
 * A descriptor without measured source bytes has no executable identity; it
 * may still be displayed, but a prompt executor must refuse to run it.
 *
 * @category hashing
 * @since 1.0.0
 */
export const executionDigest = (descriptor: FlowDescriptor): string | undefined =>
  descriptor.body.contentDigest === undefined
    ? undefined
    : Digest.digest(Digest.canonical(Schema.encodeSync(FlowDescriptor)(descriptor)))

/**
 * The budget one descriptor declared, or {@link budgetUnbounded}.
 *
 * Every host that builds an envelope goes through this rather than reading the
 * field, so "this flow declared nothing" is stated once and answered the same
 * way everywhere.
 *
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const budgetOf = (descriptor: FlowDescriptor): FlowBudget =>
  descriptor.budget === undefined ? budgetUnbounded : Object.freeze({ ...descriptor.budget })

/**
 * The result of scanning one source.
 *
 * @category models
 * @since 0.1.0
 */
export class SourceScan extends Schema.Class<SourceScan>("flows/registry/SourceScan")({
  entries: Schema.Array(FlowDescriptor),
  warnings: Schema.Array(DiscoveryWarning)
}) {}
