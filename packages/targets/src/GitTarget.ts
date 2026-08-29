/**
 * PACKAGE.ts git target flavors: `S.Git.Commit`.
 *
 * Phase W1 is construct-only; the constructor validates attrs by schema and
 * installs a {@link Target.notImplemented} implementation.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"
import * as Target from "./Target.ts"

/**
 * Attrs for {@link Commit}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CommitAttrs = Schema.Struct({
  gates: Attr.Gates,
  message: Schema.Union([Schema.NonEmptyString, Reference.AgentSelection])
})

const commitDefinition = Target.make("Git.Commit", {
  attrs: CommitAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Git.Commit")
})

/**
 * A gated commit whose message is fixed text or agent-written; outward, so
 * it runs only when named explicitly.
 *
 * @category targets
 * @since 0.1.0
 */
export const Commit = (attrs: (typeof CommitAttrs)["~type.make.in"]): Target.AnyTarget => commitDefinition(attrs)

/** Attrs for the outward pull-request rule.
 *
 * @category targets
 * @since 0.1.0
 */
export const PrAttrs = Schema.Struct({
  gates: Attr.Gates,
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox),
  approval: Schema.optional(Attr.Approval)
})

const prDefinition = Target.make("Git.Pr", {
  attrs: PrAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Git.Pr")
})

/** Opens a pull request after fresh gates.
 *
 * @category targets
 * @since 0.1.0
 */
export const Pr = (attrs: (typeof PrAttrs)["~type.make.in"]): Target.AnyTarget => prDefinition(attrs)

/** Attrs for a .gitmodules-selected submodule set.
 *
 * @category targets
 * @since 0.1.0
 */
export const SubmodulesAttrs = Schema.Struct({
  config: Input.File,
  paths: Schema.Array(Schema.NonEmptyString)
})

const submodulesDefinition = Target.make("Git.Submodules", {
  attrs: SubmodulesAttrs,
  kinds: ["build"],
  cache: true,
  implementation: () => Target.notImplemented("Git.Submodules")
})

/** Materializes submodule trees selected from a .gitmodules file.
 *
 * @category targets
 * @since 0.1.0
 */
export const Submodules = (attrs: (typeof SubmodulesAttrs)["~type.make.in"]): Target.AnyTarget =>
  submodulesDefinition(attrs)

/** Attrs for one gitlink-selected submodule.
 *
 * @category targets
 * @since 0.1.0
 */
export const SubmoduleAttrs = Schema.Struct({ path: Schema.NonEmptyString })

const submoduleDefinition = Target.make("Git.Submodule", {
  attrs: SubmoduleAttrs,
  kinds: ["build"],
  cache: true,
  implementation: () => Target.notImplemented("Git.Submodule")
})

/** Materializes one content-addressed git submodule.
 *
 * @category targets
 * @since 0.1.0
 */
export const Submodule = (attrs: (typeof SubmoduleAttrs)["~type.make.in"]): Target.AnyTarget =>
  submoduleDefinition(attrs)

/**
 * The validated attrs of one `Git.Commit` target.
 *
 * `message` is either the fixed commit text or the {@link Reference.AgentRef}
 * naming the workspace agent that writes it at execution time.
 *
 * @category accessors
 * @since 0.1.0
 */
export const commitAttrsOf = (target: Target.AnyTarget): (typeof CommitAttrs)["Type"] => {
  const metadata = Target.metadata(target)
  if (metadata.target !== "Git.Commit") {
    throw new TypeError(`expected a Git.Commit target, received ${metadata.target}`)
  }
  return metadata.attrs as (typeof CommitAttrs)["Type"]
}
