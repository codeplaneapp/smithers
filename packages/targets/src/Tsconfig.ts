/**
 * Generated TypeScript configuration.
 *
 * A `tsconfig.json` decides what the compiler reads and what it emits, which
 * makes it part of the build definition. Leaving it hand-maintained next to a
 * legacy declaration file that declares the same sources means two descriptions of one
 * thing, free to disagree. This target makes legacy declaration the only description: the
 * file is rendered from attrs, and `check` mode fails when the checked-in copy
 * has drifted.
 *
 * Include and exclude patterns are plain strings rather than {@link Input.Glob}
 * declarations. A generator's output depends on the pattern text, not on which
 * files currently match it: keying this target on matched files would make the
 * config regenerate whenever any source file changed, while changing nothing
 * about the bytes it writes.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as GeneratedFile from "./GeneratedFile.ts"
import * as Input from "./Input.ts"
import * as ManifestJson from "./ManifestJson.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link Tsconfig}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  /** Where the file is written, relative to `cwd`. @default "tsconfig.json" */
  path: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("tsconfig.json"))
  ),
  /** The base configuration this one extends, or `null`. @default null */
  extends: Schema.NullOr(Input.File).pipe(
    Schema.withConstructorDefault(Effect.succeed(null))
  ),
  /** Compiler options, rendered verbatim. @default {} */
  compilerOptions: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.withConstructorDefault(Effect.succeed<Record<string, unknown>>({}))
  ),
  /** Include patterns, in tsconfig's own glob syntax. @default [] */
  include: Schema.Array(Schema.NonEmptyString).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([]))
  ),
  /** Exclude patterns. @default [] */
  exclude: Schema.Array(Schema.NonEmptyString).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([]))
  ),
  /** Project references. @default [] */
  references: Schema.Array(Schema.NonEmptyString).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([]))
  ),
  /** Whether to write the file or verify the checked-in copy. @default "check" */
  mode: Schema.Literals(["write", "check"]).pipe(
    Schema.withConstructorDefault(Effect.succeed("check" as const))
  ),
  /** The directory the path resolves against. @default "." */
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link Tsconfig}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Renders the file contents for one declaration.
 *
 * Key order is fixed rather than alphabetical, matching how the compiler's own
 * documentation orders the sections, so a generated file reads like a
 * hand-written one and a diff against the checked-in copy is legible. The
 * trailing newline is deliberate: a file without one is a diff every editor
 * offers to fix.
 *
 * @category constructors
 * @since 0.1.0
 */
export const render = (attrs: Attrs): string => {
  const options = ManifestJson.cloneObject(attrs.compilerOptions, "Tsconfig compilerOptions")
  const document: Record<string, ManifestJson.Value> = {}
  if (attrs.extends !== null) document["extends"] = relative(attrs.cwd, attrs.extends.path)
  if (Object.keys(options).length > 0) document["compilerOptions"] = options
  if (attrs.include.length > 0) document["include"] = [...attrs.include]
  if (attrs.exclude.length > 0) document["exclude"] = [...attrs.exclude]
  if (attrs.references.length > 0) {
    document["references"] = attrs.references.map((path) => ({ path }))
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * Spells a declared path the way a tsconfig `extends` needs it.
 *
 * The compiler resolves a bare specifier as a package name, so a sibling file
 * has to carry an explicit relative prefix. A workspace-rooted `//` path is
 * rewritten relative to the directory the generated file is written into, not
 * merely stripped of its anchor: `//tsconfig.base.json` written under
 * `packages/foo` is `../../tsconfig.base.json`, and stripping alone would name
 * a sibling that is not there.
 */
const relative = (cwd: string, path: string): string => {
  const stripped = Input.rootRelative(cwd, path)
  return stripped.startsWith("./") || stripped.startsWith("../") ? stripped : `./${stripped}`
}

/**
 * Generates and drift-checks a `tsconfig.json`.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const tsconfig = Smithers.Tsconfig({
 *   extends: Smithers.file("tsconfig.base.json"),
 *   compilerOptions: { noEmit: true, module: "NodeNext" },
 *   include: ["packages/*\/src/**\/*"]
 * })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export const Tsconfig = Target.make("Tsconfig", {
  attrs: Attrs,
  kinds: ["build", "lint"],
  error: Schema.Union([GeneratedFile.WriteFileError, GeneratedFile.DriftError]),
  cache: false,
  outputs: (attrs) => attrs.mode === "write" ? { cwd: attrs.cwd, paths: [attrs.path] } : { cwd: attrs.cwd, paths: [] },
  // The check verb reads the checked-in file and writes nothing, so it is safe
  // in a lint graph; the write verb is what a build graph runs.
  attrsForKind: (kind, attrs) => kind === "lint" ? { ...attrs, mode: "check" as const } : attrs,
  implementation: (attrs) =>
    GeneratedFile.generateFile(attrs.mode, {
      path: attrs.cwd === "." ? attrs.path : `${attrs.cwd}/${attrs.path}`,
      contents: render(attrs)
    })
})
