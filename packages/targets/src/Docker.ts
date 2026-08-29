/**
 * Docker service, OCI build, bake, and outward push target declarations.
 *
 * `Docker.Serve`/`Docker.Service` run an image as a scoped,
 * readiness-gated service through the supervisor (`docker run --rm`, the
 * declared `init` commands as post-readiness `docker exec`), exactly the
 * way `Shell.Serve` supervises a host process. `Docker.Build` and
 * `Docker.Bake` are cached builds that capture an OCI archive directory
 * through the CAS. `Docker.Push` is an outward effect: uncached,
 * approval-gated, and run only with its declared secrets.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

const imageFields = {
  image: Schema.NonEmptyString,
  tag: Schema.optional(Schema.NonEmptyString)
} as const

/**
 * Attrs for `S.Docker.Serve` and `S.Docker.Service`.
 *
 * @category attrs
 * @since 0.1.0
 */
export const ServeAttrs = Schema.Struct({
  ...imageFields,
  env: Schema.optional(Attr.Env),
  ports: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  volumes: Schema.optional(Schema.Record(Schema.String, Schema.NonEmptyString)),
  readiness: Schema.optional(Attr.Readiness),
  health: Schema.optional(Attr.Health),
  stop: Schema.optional(Attr.Stop),
  init: Schema.optional(Schema.Array(Schema.NonEmptyArray(Schema.NonEmptyString))),
  command: Schema.optional(Schema.NonEmptyArray(Schema.NonEmptyString)),
  sandbox: Schema.optional(Attr.Sandbox)
})

/**
 * Attrs for a Dockerfile build.
 *
 * @category attrs
 * @since 0.1.0
 */
export const BuildAttrs = Schema.Struct({
  dockerfile: Input.File,
  context: Schema.NonEmptyString,
  platforms: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  buildArgs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  data: Schema.optional(Attr.Data),
  sandbox: Schema.optional(Attr.Sandbox)
})

/**
 * Attrs for a buildx bake target.
 *
 * @category attrs
 * @since 0.1.0
 */
export const BakeAttrs = Schema.Struct({
  config: Input.File,
  target: Schema.NonEmptyString,
  data: Schema.optional(Attr.Data),
  sandbox: Schema.optional(Attr.Sandbox)
})

/**
 * Attrs for an outward image push.
 *
 * @category attrs
 * @since 0.1.0
 */
export const PushAttrs = Schema.Struct({
  image: Target.Target,
  registry: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  tags: Schema.Array(Schema.Unknown),
  gates: Schema.optional(Attr.Gates),
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox),
  approval: Attr.Approval
})

const serveDefinition = Target.make("Docker.Serve", {
  attrs: ServeAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Docker.Serve")
})

const serviceDefinition = Target.make("Docker.Service", {
  attrs: ServeAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Docker.Service")
})

const buildDefinition = Target.make("Docker.Build", {
  attrs: BuildAttrs,
  kinds: ["build"],
  cache: true,
  outputs: () => ({ cwd: ".", paths: ["docker-image"] }),
  implementation: () => Target.notImplemented("Docker.Build")
})

const bakeDefinition = Target.make("Docker.Bake", {
  attrs: BakeAttrs,
  kinds: ["build"],
  cache: true,
  outputs: (attrs) => ({ cwd: ".", paths: [`docker-image-${attrs.target.replaceAll(/[^A-Za-z0-9._-]/g, "-")}`] }),
  implementation: () => Target.notImplemented("Docker.Bake")
})

const pushDefinition = Target.make("Docker.Push", {
  attrs: PushAttrs,
  kinds: ["run"],
  cache: false,
  implementation: () => Target.notImplemented("Docker.Push")
})

/**
 * Runs an image as a scoped service.
 *
 * @category targets
 * @since 0.1.0
 */
export const Serve = (attrs: (typeof ServeAttrs)["~type.make.in"]): Target.AnyTarget => serveDefinition(attrs)

/**
 * Alias-shaped Docker service constructor used by viem.
 *
 * @category targets
 * @since 0.1.0
 */
export const Service = (attrs: (typeof ServeAttrs)["~type.make.in"]): Target.AnyTarget => serviceDefinition(attrs)

/**
 * Builds a Dockerfile into a captured OCI archive directory.
 *
 * @category targets
 * @since 0.1.0
 */
export const Build = (attrs: (typeof BuildAttrs)["~type.make.in"]): Target.AnyTarget => buildDefinition(attrs)

/**
 * Builds one declared buildx bake target into a captured OCI archive directory.
 *
 * @category targets
 * @since 0.1.0
 */
export const Bake = (attrs: (typeof BakeAttrs)["~type.make.in"]): Target.AnyTarget => bakeDefinition(attrs)

/**
 * Declares an approval-gated, uncached image push.
 *
 * @category targets
 * @since 0.1.0
 */
export const Push = (attrs: (typeof PushAttrs)["~type.make.in"]): Target.AnyTarget => pushDefinition(attrs)
