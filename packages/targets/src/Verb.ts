/**
 * The CLI verbs a generated pipeline may run across a target graph.
 *
 * A pipeline declaration names verbs, not target kinds: `smithers-build test '//...'`
 * is one command a CI job runs, the same verb-and-pattern shape Bazel's own CI
 * uses for `bazel test //...`. Before this module a legacy declaration file named them
 * with bare strings, so the authoring surface was four quoted words whose
 * spelling nothing checked at the call site and whose meaning the attr name did
 * not explain.
 *
 * This module gives each verb a value. `Verb.Build`, `Verb.Test`, `Verb.Lint`,
 * and `Verb.Docs` are declarations a legacy declaration file references by name, so a
 * misspelling is an unresolved identifier rather than a string the renderer
 * rejects at plan time.
 *
 * The set is deliberately smaller than {@link Target.Kind}. `run` is
 * addressable from the CLI and is not here: run targets include development
 * servers and source-tree scaffolds, and an unattended pipeline must not start
 * or mutate one merely because it is addressable. A pipeline that runs `run`
 * targets is therefore not a declaration that exists, rather than one the
 * renderer refuses.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import type * as Target from "./Target.ts"

/**
 * Schema for the `build` verb.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BuildVerb = Schema.Struct({ name: Schema.Literal("build") })

/**
 * The `build` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type BuildVerb = typeof BuildVerb.Type

/**
 * Schema for the `test` verb.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TestVerb = Schema.Struct({ name: Schema.Literal("test") })

/**
 * The `test` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type TestVerb = typeof TestVerb.Type

/**
 * Schema for the `lint` verb.
 *
 * @category schemas
 * @since 0.1.0
 */
export const LintVerb = Schema.Struct({ name: Schema.Literal("lint") })

/**
 * The `lint` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type LintVerb = typeof LintVerb.Type

/**
 * Schema for the `docs` verb.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DocsVerb = Schema.Struct({ name: Schema.Literal("docs") })

/**
 * The `docs` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type DocsVerb = typeof DocsVerb.Type

/**
 * Schema for the aggregate `ci` verb.
 *
 * `ci` is not a {@link Target.Kind}: it is the CLI's own name for planning every
 * kind over one pattern in a single invocation. It has a value here so a
 * pipeline declaration can ask for the aggregate without restating the four
 * verbs it stands for.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CiVerb = Schema.Struct({ name: Schema.Literal("ci") })

/**
 * The aggregate `ci` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type CiVerb = typeof CiVerb.Type

/**
 * Schema for one verb a generated pipeline may run.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Verb = Schema.Union([BuildVerb, TestVerb, LintVerb, DocsVerb])

/**
 * One verb a generated pipeline may run.
 *
 * @category models
 * @since 0.1.0
 */
export type Verb = typeof Verb.Type

/**
 * Builds every target in the pattern.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * // Runs `smithers-build build '//...'`
 * export const verbs = [Smithers.Verb.Build]
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Build: BuildVerb = BuildVerb.make({ name: "build" })

/**
 * Runs every test target in the pattern.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Test: TestVerb = TestVerb.make({ name: "test" })

/**
 * Runs every lint target in the pattern.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Lint: LintVerb = LintVerb.make({ name: "lint" })

/**
 * Runs the documentation-parity check over the pattern.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Docs: DocsVerb = DocsVerb.make({ name: "docs" })

/**
 * Every verb a generated pipeline may run, in the order the CLI aggregates
 * them.
 *
 * A pipeline declaring exactly this set is the aggregate `ci` command, so the
 * renderer collapses it to one step.
 *
 * @category constants
 * @since 0.1.0
 */
export const all: ReadonlyArray<Verb> = [Build, Test, Lint, Docs]

/**
 * Plans and runs every verb over one pattern in a single invocation.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * // Runs `smithers-build ci '//packages/...'`
 * export const verb = Smithers.Verb.Ci
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Ci: CiVerb = CiVerb.make({ name: "ci" })

/**
 * Schema for one verb a generated pipeline step may run, aggregate included.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PipelineVerb = Schema.Union([BuildVerb, TestVerb, LintVerb, DocsVerb, CiVerb])

/**
 * One verb a generated pipeline step may run, aggregate included.
 *
 * @category models
 * @since 0.1.0
 */
export type PipelineVerb = typeof PipelineVerb.Type

/**
 * Checks whether a value is a pipeline verb.
 *
 * @category guards
 * @since 0.1.0
 */
export const isVerb: (value: unknown) => value is Verb = Schema.is(Verb)

/**
 * Checks whether a value is a verb a generated pipeline step may run.
 *
 * @category guards
 * @since 0.1.0
 */
export const isPipelineVerb: (value: unknown) => value is PipelineVerb = Schema.is(PipelineVerb)

/**
 * The CLI subcommand one pipeline verb names.
 *
 * @category accessors
 * @since 0.1.0
 */
export const command = (verb: PipelineVerb): string => verb.name

/**
 * The target kind one verb selects.
 *
 * The return type is what keeps this module and {@link Target.Kind} from
 * drifting: a verb whose name is not a kind the CLI has would not typecheck
 * here.
 *
 * @category accessors
 * @since 0.1.0
 */
export const kind = (verb: Verb): Target.Kind => verb.name
