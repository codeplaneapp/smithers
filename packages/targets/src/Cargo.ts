/**
 * Cargo gates as declared targets.
 *
 * The three checks a Rust workspace gates on — `cargo fmt --check`,
 * `cargo clippy`, and `cargo test` — were shell strings in a BUILD.ts file
 * until this module existed. Each is now a declaration whose argv the
 * implementation renders, on the same terms as every other target: the flags
 * that make a check a gate rather than a fixer live here, not at the call site.
 *
 * There are two target types rather than one because a target's participating
 * verbs are fixed by its type, not by its attrs: the planner selects by kind, so
 * one type covering both verbs would put `cargo fmt` in the graph of
 * `smthrs test`. {@link CargoLint} is the lint gate and {@link CargoTest} is the
 * test gate, and each takes only the checks that belong to its verb.
 *
 * Bazel's `rules_rust` models the same gates as `rustfmt_test`, `rust_clippy`,
 * and `rust_test`, one rule apiece. The deviation here is the check union: all
 * three run the same executable over the same declared crate sources and differ
 * only in argv, so the split is one level down, in the discriminated union each
 * target takes.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Compose from "./Compose.ts"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as RustToolchain from "./RustToolchain.ts"
import * as Target from "./Target.ts"

/**
 * Schema for a `cargo fmt --check` gate.
 *
 * There is no "fix" option: a formatter that rewrites the tree is not a gate,
 * and a target that could be either would make every declaration a question
 * about which one it is.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FmtCheck = Schema.Struct({ name: Schema.Literal("fmt") })

/**
 * A `cargo fmt --check` gate.
 *
 * @category models
 * @since 0.1.0
 */
export type FmtCheck = typeof FmtCheck.Type

/**
 * Schema for a `cargo clippy` gate.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ClippyCheck = Schema.Struct({
  name: Schema.Literal("clippy"),
  /** Lint tests, benches, and examples too, not just the library targets. */
  allTargets: Schema.Boolean,
  /** Refuse to update `Cargo.lock`, so the gate's result does not depend on when it ran. */
  locked: Schema.Boolean,
  /** Promote every warning to an error, which is what makes clippy a gate. */
  denyWarnings: Schema.Boolean
})

/**
 * A `cargo clippy` gate.
 *
 * @category models
 * @since 0.1.0
 */
export type ClippyCheck = typeof ClippyCheck.Type

/**
 * Schema for a `cargo test` gate.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TestCheck = Schema.Struct({
  name: Schema.Literal("test"),
  /** Refuse to update `Cargo.lock`. */
  locked: Schema.Boolean
})

/**
 * A `cargo test` gate.
 *
 * @category models
 * @since 0.1.0
 */
export type TestCheck = typeof TestCheck.Type

/**
 * Schema for one declared cargo lint gate.
 *
 * @category schemas
 * @since 0.1.0
 */
export const LintCheck = Schema.Union([FmtCheck, ClippyCheck])

/**
 * One declared cargo lint gate.
 *
 * @category models
 * @since 0.1.0
 */
export type LintCheck = typeof LintCheck.Type

/** Declares the BUILD-era `cargo fmt --check` gate; see {@link Fmt}. */
const fmtCheck = (): FmtCheck => FmtCheck.make({ name: "fmt" })

/**
 * Declares the BUILD-era `cargo clippy` gate; see {@link Clippy}.
 *
 * The defaults are the gate form: every target, a frozen lockfile, and warnings
 * as errors. A declaration that wants less has to say so.
 */
const clippyCheck = (options: {
  /** @default true */
  readonly allTargets?: boolean | undefined
  /** @default true */
  readonly locked?: boolean | undefined
  /** @default true */
  readonly denyWarnings?: boolean | undefined
} = {}): ClippyCheck =>
  ClippyCheck.make({
    name: "clippy",
    allTargets: options.allTargets ?? true,
    locked: options.locked ?? true,
    denyWarnings: options.denyWarnings ?? true
  })

/** Declares the BUILD-era `cargo test` gate; see {@link Test}. */
const testCheck = (options: {
  /** @default true */
  readonly locked?: boolean | undefined
} = {}): TestCheck => TestCheck.make({ name: "test", locked: options.locked ?? true })

/**
 * Attributes shared by {@link CargoLint} and {@link CargoTest}.
 *
 * `cwd` is the workspace-relative directory cargo runs in and defaults to the
 * workspace root, so a crate inside a cargo workspace is checked from the root
 * that owns `Cargo.lock`.
 *
 * @category schemas
 * @since 0.1.0
 */
const common = {
  toolchain: RustToolchain.RustToolchain,
  /** Crate sources, manifests, and the lockfile, digested as key material. */
  srcs: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
}

/**
 * Attributes for {@link CargoLint}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const LintAttrs = Schema.Struct({ ...common, check: LintCheck })

/**
 * Attributes for {@link CargoLint}.
 *
 * @category models
 * @since 0.1.0
 */
export type LintAttrs = typeof LintAttrs.Type

/**
 * Attributes for {@link CargoTest}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TestAttrs = Schema.Struct({ ...common, check: TestCheck })

/**
 * Attributes for {@link CargoTest}.
 *
 * @category models
 * @since 0.1.0
 */
export type TestAttrs = typeof TestAttrs.Type

/**
 * Builds the gate argv from decoded attrs at plan time.
 *
 * `--` separates cargo's own options from the ones clippy forwards to rustc,
 * which is where `-D warnings` has to go: passed before it, cargo reads it as
 * one of its own and rejects it.
 *
 * @category rendering
 * @since 0.1.0
 */
export const checkArgv = (
  toolchain: RustToolchain.RustToolchain,
  check: LintCheck | TestCheck
): ReadonlyArray<string> => {
  switch (check.name) {
    case "fmt":
      return RustToolchain.cargo(toolchain, ["fmt", "--check"])
    case "clippy":
      return RustToolchain.cargo(toolchain, [
        "clippy",
        ...(check.allTargets ? ["--all-targets"] : []),
        ...(check.locked ? ["--locked"] : []),
        ...(check.denyWarnings ? ["--", "-D", "warnings"] : [])
      ])
    case "test":
      return RustToolchain.cargo(toolchain, ["test", ...(check.locked ? ["--locked"] : [])])
  }
}

/**
 * Runs one declared cargo lint gate.
 *
 * The plan runs cargo in `cwd` through the shared {@link Exec.Exec} action.
 * Success carries the {@link Exec.Result} run summary; the target declares no
 * output directories, because a gate's product is its exit code. Crate sources
 * and the toolchain declaration are the key material, so a gate re-runs when the
 * sources move or the pin changes and not otherwise. Executing the plan requires
 * {@link Exec.ExecLive} and a host with the declared toolchain installed.
 *
 * @category targets
 * @since 0.1.0
 */
export const CargoLint = Target.make("CargoLint", {
  attrs: LintAttrs,
  kinds: ["lint"],
  success: Exec.Result,
  error: Exec.ExecError,
  implementation: (attrs) => Target.runTool({ cwd: attrs.cwd, argv: checkArgv(attrs.toolchain, attrs.check) })
})

/**
 * Runs the declared `cargo test` gate.
 *
 * The same shape as {@link CargoLint}, under the test verb.
 *
 * @category targets
 * @since 0.1.0
 */
export const CargoTest = Target.make("CargoTest", {
  attrs: TestAttrs,
  kinds: ["test"],
  success: Exec.Result,
  error: Exec.ExecError,
  implementation: (attrs) => Target.runTool({ cwd: attrs.cwd, argv: checkArgv(attrs.toolchain, attrs.check) })
})

// ---------------------------------------------------------------------------
// Package mode: the crate-set cargo surface
// ---------------------------------------------------------------------------

/**
 * Schema for one `[package.metadata]` filter, `S.Cargo.AppSet({ metadata })`.
 *
 * The filter is matched as a subset of a manifest's own metadata table, so
 * `{ aomi: { skip: true } }` selects exactly the crates whose manifest sets
 * `[package.metadata.aomi] skip = true`. The key is the compile driver's
 * existing opt-out, not a new one: a crate set is a view over what the
 * manifests already say.
 *
 * @category schemas
 * @since 0.1.0
 */
export const MetadataFilter = Schema.Record(Schema.String, Schema.Unknown)

/**
 * One `[package.metadata]` filter.
 *
 * @category models
 * @since 0.1.0
 */
export type MetadataFilter = typeof MetadataFilter.Type

/**
 * Schema for a declared crate set: an {@link AppSet} target, or a file-algebra
 * difference of two of them.
 *
 * A crate set settles to the same set type `S.ImportClosure` produces, which
 * is what lets `S.Files.difference` compose over it: subtracting the opted-out
 * crates from every crate is the same operator, one level up.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CrateSet = Schema.Union([Target.Target, Compose.FilesDifference])

/**
 * One declared crate set.
 *
 * @category models
 * @since 0.1.0
 */
export type CrateSet = typeof CrateSet.Type

/**
 * Which crates one planned cargo command runs over.
 *
 * The planner resolves a declaration's crate selector to one of these before
 * rendering argv: a whole workspace, one named package, or one crate's own
 * manifest. A crate-set declaration renders one command per member, so the
 * selection is per command, never per declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type CrateSelection =
  | { readonly _tag: "Workspace" }
  | { readonly _tag: "Package"; readonly name: string }
  | { readonly _tag: "Manifest"; readonly path: string }

/** The three ways a package-mode cargo declaration may name its crates. */
const crateSelectors = ["workspace", "package", "crates"] as const

/** The crate-selector fields every package-mode cargo rule shares. */
const selectorFields = {
  /** The whole cargo workspace: `--workspace`. */
  workspace: Schema.optional(Schema.Literal(true)),
  /** One named package: `-p <name>`. */
  package: Schema.optional(Schema.NonEmptyString),
  /** A crate set, one command per member: `--manifest-path <manifest>`. */
  crates: Schema.optional(CrateSet)
} as const

/** The edge and confinement fields every package-mode cargo rule shares. */
const cargoShared = {
  data: Schema.optional(Attr.Data),
  env: Schema.optional(Attr.Env),
  sandbox: Schema.optional(Attr.Sandbox)
} as const

/** The dependency-resolution fields every cargo rule that resolves has. */
const resolutionFields = {
  /** Refuse to update the lockfile, so the result does not depend on when it ran. */
  locked: Schema.optional(Schema.Boolean),
  /** Resolve only from what the fetch resource already delivered. */
  offline: Schema.optional(Schema.Boolean)
} as const

/** The feature-selection fields the compiling rules share. */
const featureFields = {
  features: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  allFeatures: Schema.optional(Schema.Boolean)
} as const

/**
 * Attrs for {@link Fetch}: the one network-enabled cargo target.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FetchAttrs = Schema.Struct({
  /** The workspace manifest cargo resolves from. */
  workspace: Schema.optional(Input.File),
  /**
   * A crate set to lock instead of one workspace manifest.
   *
   * A repository whose crates are excluded from the root workspace has one
   * lockfile domain per crate, so one fetch over one manifest cannot deliver
   * what those crates resolve against. Naming the set locks each of them.
   */
  crates: Schema.optional(CrateSet),
  /** Files this resource delivers, workspace-anchored. */
  outFiles: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  /** Directories this resource delivers; the first one becomes `CARGO_HOME`. */
  outDirs: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  ...cargoShared
})

/**
 * Attrs for {@link Fetch}.
 *
 * @category models
 * @since 0.1.0
 */
export type FetchAttrs = typeof FetchAttrs.Type

/**
 * Attrs for the package-mode {@link Build}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BuildAttrs = Schema.Struct({
  ...selectorFields,
  ...featureFields,
  ...resolutionFields,
  ...cargoShared,
  /** Named binary targets: `--bin <name>` apiece. */
  bins: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  /** Library targets only: `--lib`. */
  lib: Schema.optional(Schema.Boolean),
  /** `"release"` renders `--release`; any other name renders `--profile <name>`. */
  profile: Schema.optional(Schema.NonEmptyString),
  /** Rust compilation target triple. */
  target: Schema.optional(Schema.NonEmptyString),
  /** Cross-compilation driver requested by the declaration. */
  container: Schema.optional(Schema.Literal("docker")),
  outDirs: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

/**
 * Attrs for the package-mode {@link Build}.
 *
 * @category models
 * @since 0.1.0
 */
export type BuildAttrs = typeof BuildAttrs.Type

/**
 * Attrs for the package-mode {@link Test}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PackageTestAttrs = Schema.Struct({
  ...selectorFields,
  ...featureFields,
  ...resolutionFields,
  ...cargoShared,
  bins: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  lib: Schema.optional(Schema.Boolean),
  /** Compile the tests without running them: `--no-run`. */
  noRun: Schema.optional(Schema.Boolean),
  gates: Schema.optional(Attr.Gates)
})

/**
 * Attrs for the package-mode {@link Test}.
 *
 * @category models
 * @since 0.1.0
 */
export type PackageTestAttrs = typeof PackageTestAttrs.Type

/**
 * Attrs for cargo-nextest over a workspace, package, or crate set.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NextestAttrs = PackageTestAttrs

/**
 * Attrs for cargo-deny.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DenyAttrs = Schema.Struct({
  config: Input.File,
  ...cargoShared
})

/**
 * Attrs for the package-mode {@link Clippy}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PackageClippyAttrs = Schema.Struct({
  ...selectorFields,
  ...featureFields,
  ...resolutionFields,
  ...cargoShared,
  lib: Schema.optional(Schema.Boolean),
  allTargets: Schema.optional(Schema.Boolean),
  /** Promote every warning to an error, which is what makes clippy a gate. */
  denyWarnings: Schema.optional(Schema.Boolean)
})

/**
 * Attrs for the package-mode {@link Clippy}.
 *
 * @category models
 * @since 0.1.0
 */
export type PackageClippyAttrs = typeof PackageClippyAttrs.Type

/**
 * Attrs for the package-mode {@link Fmt}.
 *
 * There is no `locked` or `offline` field: rustfmt reads sources and never
 * resolves a dependency, so it is the one cargo rule with no edge on the fetch
 * resource and nothing for those flags to mean.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FmtAttrs = Schema.Struct({
  workspace: Schema.optional(Schema.Literal(true)),
  crates: Schema.optional(CrateSet),
  ...cargoShared,
  /** The write set `--write`/`--fix` is confined to; check mode diffs instead. */
  changes: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  /** Optional rustup toolchain override, rendered as `cargo +<toolchain>`. */
  toolchain: Schema.optional(Schema.NonEmptyString)
})

/**
 * Attrs for the package-mode {@link Fmt}.
 *
 * @category models
 * @since 0.1.0
 */
export type FmtAttrs = typeof FmtAttrs.Type

/**
 * Attrs for {@link Doc}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DocAttrs = Schema.Struct({
  ...selectorFields,
  ...featureFields,
  ...resolutionFields,
  ...cargoShared,
  outDirs: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

/**
 * Attrs for {@link Doc}.
 *
 * @category models
 * @since 0.1.0
 */
export type DocAttrs = typeof DocAttrs.Type

/**
 * Attrs for {@link AppSet}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AppSetAttrs = Schema.Struct({
  /** Manifest globs, resolved against the declaring PACKAGE.ts directory. */
  manifests: Schema.Union([Input.Glob, Schema.Array(Input.Glob)]),
  metadata: Schema.optional(MetadataFilter)
})

/**
 * Attrs for {@link AppSet}.
 *
 * @category models
 * @since 0.1.0
 */
export type AppSetAttrs = typeof AppSetAttrs.Type

/**
 * The rule id every package-mode cargo target reports.
 *
 * @category constants
 * @since 0.1.0
 */
export const packageRules = [
  "Cargo.Fetch",
  "Cargo.Build",
  "Cargo.Test",
  "Cargo.Nextest",
  "Cargo.Clippy",
  "Cargo.Fmt",
  "Cargo.Doc",
  "Cargo.AppSet",
  "Cargo.Deny"
] as const

/**
 * One package-mode cargo rule id.
 *
 * @category models
 * @since 0.1.0
 */
export type PackageRule = (typeof packageRules)[number]

const optionalArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

const selectionArgs = (selection: CrateSelection): ReadonlyArray<string> => {
  switch (selection._tag) {
    case "Workspace":
      return ["--workspace"]
    case "Package":
      return ["-p", selection.name]
    case "Manifest":
      return ["--manifest-path", selection.path]
  }
}

const featureArgs = (attrs: Record<string, unknown>): ReadonlyArray<string> => {
  if (attrs["allFeatures"] === true) return ["--all-features"]
  const features = optionalArray(attrs["features"])
  return features.length === 0 ? [] : ["--features", features.join(",")]
}

const profileArgs = (attrs: Record<string, unknown>): ReadonlyArray<string> => {
  const profile = attrs["profile"]
  if (typeof profile !== "string" || profile === "dev") return []
  return profile === "release" ? ["--release"] : ["--profile", profile]
}

const compilationTargetArgs = (attrs: Record<string, unknown>): ReadonlyArray<string> =>
  typeof attrs["target"] === "string" ? ["--target", attrs["target"]] : []

const resolutionArgs = (attrs: Record<string, unknown>): ReadonlyArray<string> => [
  ...(attrs["locked"] === true ? ["--locked"] : []),
  ...(attrs["offline"] === true ? ["--offline"] : [])
]

const targetArgs = (attrs: Record<string, unknown>): ReadonlyArray<string> => [
  ...(attrs["lib"] === true ? ["--lib"] : []),
  ...(attrs["allTargets"] === true ? ["--all-targets"] : []),
  ...optionalArray(attrs["bins"]).flatMap((bin) => ["--bin", bin])
]

/**
 * Renders the cargo arguments one planned command runs, without the
 * executable.
 *
 * The planner prepends the cargo path it resolved from the workspace toolchain
 * layer, so the executable is never in the declaration and never in this
 * rendering. Argument order is fixed here rather than at any call site, which
 * is what makes two declarations that say the same thing key the same.
 *
 * `mode` selects between the checking and applying forms of a rule that has
 * both: `Cargo.Fmt` renders `-- --check` in `check` mode and nothing in
 * `write` mode. Every other rule ignores it.
 *
 * @category rendering
 * @since 0.1.0
 */
export const packageArgs = (
  rule: string,
  attrs: unknown,
  selection: CrateSelection,
  mode: "check" | "write" | "execute" = "execute"
): ReadonlyArray<string> => {
  const values = (typeof attrs === "object" && attrs !== null ? attrs : {}) as Record<string, unknown>
  switch (rule) {
    case "Cargo.Fetch":
      // A fetch names one manifest or none; there is no `--workspace` for it.
      return ["fetch", ...(selection._tag === "Manifest" ? ["--manifest-path", selection.path] : [])]
    case "Cargo.Build":
      return [
        "build",
        ...selectionArgs(selection),
        ...targetArgs(values),
        ...featureArgs(values),
        ...profileArgs(values),
        ...compilationTargetArgs(values),
        ...resolutionArgs(values)
      ]
    case "Cargo.Test":
      return [
        "test",
        ...selectionArgs(selection),
        ...targetArgs(values),
        ...featureArgs(values),
        ...(values["noRun"] === true ? ["--no-run"] : []),
        ...resolutionArgs(values)
      ]
    case "Cargo.Nextest":
      return [
        "nextest",
        "run",
        ...selectionArgs(selection),
        ...targetArgs(values),
        ...featureArgs(values),
        ...(values["noRun"] === true ? ["--no-run"] : []),
        ...resolutionArgs(values)
      ]
    case "Cargo.Clippy":
      return [
        "clippy",
        ...selectionArgs(selection),
        ...targetArgs(values),
        ...featureArgs(values),
        ...resolutionArgs(values),
        // `-D warnings` is a rustc flag, so it goes after the separator:
        // passed before it, cargo reads it as one of its own and rejects it.
        ...(values["denyWarnings"] === true ? ["--", "-D", "warnings"] : [])
      ]
    case "Cargo.Fmt":
      return [
        ...(typeof values["toolchain"] === "string" ? [`+${values["toolchain"]}`] : []),
        "fmt",
        ...(selection._tag === "Manifest" ? ["--manifest-path", selection.path] : []),
        "--all",
        ...(mode === "write" ? [] : ["--", "--check"])
      ]
    case "Cargo.Doc":
      return ["doc", ...selectionArgs(selection), ...featureArgs(values), ...resolutionArgs(values)]
    case "Cargo.Deny":
      return ["deny", "--config", (values["config"] as Input.File).path, "check"]
    default:
      throw new Error(`${rule} is not a package-mode cargo rule`)
  }
}

/**
 * The workspace-relative paths of the binaries one {@link Build} declaration
 * produces.
 *
 * A build that names its bins under a known profile produces known paths,
 * which is what lets another target take it as a tool edge
 * (`S.Shell.Build({ bin: sdk.buildCli })`). A build that names none produces
 * nothing addressable, and the planner refuses the tool edge by name rather
 * than guessing.
 *
 * @category accessors
 * @since 0.1.0
 */
export const binaries = (attrs: unknown): ReadonlyArray<string> => {
  const values = (typeof attrs === "object" && attrs !== null ? attrs : {}) as Record<string, unknown>
  const profile = typeof values["profile"] === "string" ? values["profile"] : "dev"
  const directory = profile === "dev" ? "debug" : profile
  return optionalArray(values["bins"]).map((bin) => `target/${directory}/${bin}`)
}

/**
 * The `[package.metadata]` filter one {@link AppSet} declaration carries.
 *
 * @category accessors
 * @since 0.1.0
 */
export const appSetFilter = (attrs: unknown): MetadataFilter | undefined => {
  const values = (typeof attrs === "object" && attrs !== null ? attrs : {}) as Record<string, unknown>
  const metadata = values["metadata"]
  return typeof metadata === "object" && metadata !== null ? metadata as MetadataFilter : undefined
}

/**
 * Whether a manifest's metadata table satisfies a declared filter.
 *
 * The filter matches as a subset: every key it names must be present with the
 * same value, and keys it does not name are ignored. Nested tables recurse;
 * scalars compare by value.
 *
 * @category matching
 * @since 0.1.0
 */
export const metadataMatches = (metadata: unknown, filter: unknown): boolean => {
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) return metadata === filter
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return false
  for (const [key, expected] of Object.entries(filter as Record<string, unknown>)) {
    if (!metadataMatches((metadata as Record<string, unknown>)[key], expected)) return false
  }
  return true
}

/**
 * The crate name and `[package.metadata]` table one `Cargo.toml` declares.
 *
 * This reads exactly the two things a crate set needs and nothing else: the
 * planner never resolves a dependency graph out of a manifest, and a manifest
 * feature this does not understand is ignored rather than guessed at. Table
 * headers, bare and quoted keys, and the scalar value forms TOML spells the
 * same way JSON does are read; arrays, inline tables, and multi-line strings
 * are skipped, because no crate-set decision has ever depended on one.
 *
 * @category parsing
 * @since 0.1.0
 */
export const manifestFacts = (
  text: string
): { readonly name: string | undefined; readonly metadata: Record<string, unknown> } => {
  let name: string | undefined
  const metadata: Record<string, unknown> = {}
  let path: ReadonlyArray<string> | undefined
  const unquote = (token: string): string =>
    (token.startsWith("\"") && token.endsWith("\"") && token.length >= 2) ||
      (token.startsWith("'") && token.endsWith("'") && token.length >= 2)
      ? token.slice(1, -1)
      : token
  const splitHeader = (header: string): ReadonlyArray<string> => {
    const parts: Array<string> = []
    let current = ""
    let quote: string | undefined
    for (const character of header) {
      if (quote !== undefined) {
        if (character === quote) quote = undefined
        else current += character
        continue
      }
      if (character === "\"" || character === "'") {
        quote = character
        continue
      }
      if (character === ".") {
        parts.push(current.trim())
        current = ""
        continue
      }
      current += character
    }
    parts.push(current.trim())
    return parts
  }
  const scalar = (raw: string): unknown => {
    const token = raw.trim()
    if (token === "true") return true
    if (token === "false") return false
    if (/^-?\d+$/.test(token)) return Number(token)
    if (/^-?\d+\.\d+$/.test(token)) return Number(token)
    if (
      (token.startsWith("\"") && token.endsWith("\"") && token.length >= 2) ||
      (token.startsWith("'") && token.endsWith("'") && token.length >= 2)
    ) return token.slice(1, -1)
    return undefined
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue
    if (line.startsWith("[")) {
      const end = line.indexOf("]")
      if (end === -1) continue
      // `[[array.of.tables]]` is not a table this reader models.
      path = line.startsWith("[[") ? undefined : splitHeader(line.slice(1, end))
      continue
    }
    const separator = line.indexOf("=")
    if (separator === -1 || path === undefined) continue
    const key = unquote(line.slice(0, separator).trim())
    // A `#` inside a quoted value is not a comment; strip only a trailing one.
    const rest = line.slice(separator + 1)
    const quoted = /^\s*(?:"[^"]*"|'[^']*')/.exec(rest)
    const value = scalar(quoted === null ? rest.split("#")[0]! : quoted[0])
    if (value === undefined) continue
    if (path.length === 1 && path[0] === "package" && key === "name" && typeof value === "string") {
      name = value
      continue
    }
    if (path.length < 3 || path[0] !== "package" || path[1] !== "metadata") continue
    let table = metadata
    for (const segment of path.slice(2)) {
      const existing = table[segment]
      if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
        table = existing as Record<string, unknown>
      } else {
        const created: Record<string, unknown> = {}
        table[segment] = created
        table = created
      }
    }
    table[key] = value
  }
  return { name, metadata }
}

/**
 * Refuses a declaration that names more than one crate selector.
 *
 * `Cargo.Fetch` is the one rule that may name none — `cargo fetch` with no
 * `--manifest-path` resolves the manifest in the directory it runs from,
 * which is the workspace root every target spawns from — so it asks for at
 * most one rather than exactly one. Naming two would say two different things
 * about which lockfile domains the resource locks.
 */
const requireAtMostOneSelector = (id: string, attrs: unknown, selectors: ReadonlyArray<string>): void => {
  if (attrs === undefined) return
  if (typeof attrs !== "object" || attrs === null) throw new TypeError(`${id} attrs must be an object`)
  const values = attrs as Record<string, unknown>
  const present = selectors.filter((selector) => values[selector] !== undefined)
  if (present.length > 1) {
    throw new Error(`${id} requires at most one of ${selectors.join(", ")}; received ${present.join(", ")}`)
  }
}

const requireOneSelector = (id: string, attrs: unknown, selectors: ReadonlyArray<string>): void => {
  if (typeof attrs !== "object" || attrs === null) throw new TypeError(`${id} attrs must be an object`)
  const values = attrs as Record<string, unknown>
  const present = selectors.filter((selector) => values[selector] !== undefined)
  if (present.length !== 1) {
    throw new Error(
      `${id} requires exactly one of ${selectors.join(", ")}; received ${
        present.length === 0 ? "none" : present.join(", ")
      }`
    )
  }
  if (values["features"] !== undefined && values["allFeatures"] === true) {
    throw new Error(`${id} declares both features and allFeatures; cargo accepts one or the other`)
  }
}

/** Whether an argument selects the package-mode target rather than a BUILD-era check. */
const namesCrates = (attrs: unknown): boolean =>
  typeof attrs === "object" && attrs !== null &&
  crateSelectors.some((selector) => (attrs as Record<string, unknown>)[selector] !== undefined)

const fetchDefinition = Target.make("Cargo.Fetch", {
  attrs: FetchAttrs,
  kinds: ["build"],
  implementation: () => Target.notImplemented("Cargo.Fetch")
})

const buildDefinition = Target.make("Cargo.Build", {
  attrs: BuildAttrs,
  kinds: ["build"],
  implementation: () => Target.notImplemented("Cargo.Build")
})

const packageTestDefinition = Target.make("Cargo.Test", {
  attrs: PackageTestAttrs,
  kinds: ["test"],
  implementation: () => Target.notImplemented("Cargo.Test")
})

const nextestDefinition = Target.make("Cargo.Nextest", {
  attrs: NextestAttrs,
  kinds: ["test"],
  implementation: () => Target.notImplemented("Cargo.Nextest")
})

const denyDefinition = Target.make("Cargo.Deny", {
  attrs: DenyAttrs,
  kinds: ["lint"],
  implementation: () => Target.notImplemented("Cargo.Deny")
})

const packageClippyDefinition = Target.make("Cargo.Clippy", {
  attrs: PackageClippyAttrs,
  kinds: ["lint"],
  implementation: () => Target.notImplemented("Cargo.Clippy")
})

const packageFmtDefinition = Target.make("Cargo.Fmt", {
  attrs: FmtAttrs,
  kinds: ["lint"],
  implementation: () => Target.notImplemented("Cargo.Fmt")
})

const docDefinition = Target.make("Cargo.Doc", {
  attrs: DocAttrs,
  kinds: ["build", "docs"],
  implementation: () => Target.notImplemented("Cargo.Doc")
})

const appSetDefinition = Target.make("Cargo.AppSet", {
  attrs: AppSetAttrs,
  kinds: [],
  implementation: () => Target.notImplemented("Cargo.AppSet")
})

/**
 * The single network-enabled cargo target: `cargo fetch`.
 *
 * The lockfile and the vendored registry are declared deliverables, so every
 * other cargo target consumes them offline through a `data` edge on this one.
 * Its first declared `outDirs` entry is the `CARGO_HOME` the planner pins for
 * this target and for every dependent, which is what makes `--offline` mean
 * "read what the fetch delivered" rather than "read whatever the host has".
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * const fetch = S.Cargo.Fetch({
 *   workspace: S.file("//Cargo.toml"),
 *   outFiles: ["//Cargo.lock"],
 *   outDirs: ["//.cargo-home"],
 *   sandbox: { network: true }
 * })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export const Fetch = (attrs: (typeof FetchAttrs)["~type.make.in"]): Target.AnyTarget => {
  requireAtMostOneSelector("Cargo.Fetch", attrs, ["workspace", "crates"])
  return fetchDefinition(attrs)
}

/**
 * A `cargo build` over a workspace, one package, or a crate set.
 *
 * @category targets
 * @since 0.1.0
 */
export const Build = (attrs: (typeof BuildAttrs)["~type.make.in"]): Target.AnyTarget => {
  requireOneSelector("Cargo.Build", attrs, crateSelectors)
  return buildDefinition(attrs)
}

/**
 * Runs cargo-nextest over the selected crates.
 *
 * @category targets
 * @since 0.1.0
 */
export const Nextest = (attrs: (typeof NextestAttrs)["~type.make.in"]): Target.AnyTarget => {
  requireOneSelector("Cargo.Nextest", attrs, crateSelectors)
  return nextestDefinition(attrs)
}

/**
 * Runs cargo-deny against the declared policy.
 *
 * @category targets
 * @since 0.1.0
 */
export const Deny = (attrs: (typeof DenyAttrs)["~type.make.in"]): Target.AnyTarget => denyDefinition(attrs)

/**
 * A `cargo doc` build over a workspace, one package, or a crate set.
 *
 * @category targets
 * @since 0.1.0
 */
export const Doc = (attrs: (typeof DocAttrs)["~type.make.in"]): Target.AnyTarget => {
  requireOneSelector("Cargo.Doc", attrs, crateSelectors)
  return docDefinition(attrs)
}

/**
 * A crate set computed from manifest globs, filterable by
 * `[package.metadata]`.
 *
 * The set is a value, not a run: it participates in no verb and produces no
 * process. `S.Files.difference(all, skipped)` subtracts one set from another,
 * and the cargo rules take the result as their `crates` selector.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * const allApps = S.Cargo.AppSet({ manifests: S.glob(["*\/Cargo.toml"]) })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export const AppSet = (attrs: (typeof AppSetAttrs)["~type.make.in"]): Target.AnyTarget => appSetDefinition(attrs)

/**
 * Checks whether a value is a declared crate set.
 *
 * @category guards
 * @since 0.1.0
 */
export const isAppSet = (value: unknown): value is Target.AnyTarget =>
  Target.isTarget(value) && Target.metadata(value).target === "Cargo.AppSet"

// ---------------------------------------------------------------------------
// The three shared names
// ---------------------------------------------------------------------------

// `Fmt`, `Clippy`, and `Test` name both a BUILD-era check value — the attr the
// legacy `CargoLint`/`CargoTest` targets take — and a package-mode target.
// Keeping one name for each is deliberate: a repository migrating from BUILD.ts
// to PACKAGE.ts does not rename its cargo gates on the way. The two forms are
// told apart by the crate selector, which every package-mode declaration must
// name and no BUILD-era call ever passes: `Cargo.Clippy()` and
// `Cargo.Clippy({ locked: false })` are checks, and
// `Cargo.Clippy({ workspace: true, ... })` is a target. `Cargo.Fmt` takes no
// BUILD-era options at all, so a bare call is the check and any object is the
// target.

/**
 * The `cargo fmt` gate: a BUILD-era check value when called bare, and the
 * package-mode target when called with a crate selector.
 *
 * The package-mode form checks by default and applies under `--write`/`--fix`,
 * confined to the declared `changes` write set. It is the one cargo rule with
 * no `locked`/`offline` attrs, because rustfmt never resolves a dependency.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * const format = S.Cargo.Fmt({ workspace: true, data: [], changes: ["**\/*.rs"] })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export function Fmt(): FmtCheck
export function Fmt(attrs: (typeof FmtAttrs)["~type.make.in"]): Target.AnyTarget
export function Fmt(attrs?: (typeof FmtAttrs)["~type.make.in"]): FmtCheck | Target.AnyTarget {
  if (attrs === undefined) return fmtCheck()
  requireAtMostOneSelector("Cargo.Fmt", attrs, ["workspace", "crates"])
  return packageFmtDefinition(attrs)
}

/**
 * The `cargo clippy` gate: a BUILD-era check value without a crate selector,
 * and the package-mode target with one.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * const clippy = S.Cargo.Clippy({ workspace: true, lib: true, denyWarnings: true, locked: true })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export function Clippy(options?: {
  readonly allTargets?: boolean | undefined
  readonly locked?: boolean | undefined
  readonly denyWarnings?: boolean | undefined
}): ClippyCheck
export function Clippy(attrs: (typeof PackageClippyAttrs)["~type.make.in"]): Target.AnyTarget
export function Clippy(attrs?: unknown): ClippyCheck | Target.AnyTarget {
  if (!namesCrates(attrs)) return clippyCheck(attrs as Parameters<typeof clippyCheck>[0])
  requireOneSelector("Cargo.Clippy", attrs, crateSelectors)
  return packageClippyDefinition(
    attrs as (typeof PackageClippyAttrs)["~type.make.in"]
  )
}

/**
 * The `cargo test` gate: a BUILD-era check value without a crate selector, and
 * the package-mode target with one.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * const test = S.Cargo.Test({ package: "aomi-sdk", locked: true, offline: true })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export function Test(options?: { readonly locked?: boolean | undefined }): TestCheck
export function Test(attrs: (typeof PackageTestAttrs)["~type.make.in"]): Target.AnyTarget
export function Test(attrs?: unknown): TestCheck | Target.AnyTarget {
  if (!namesCrates(attrs)) return testCheck(attrs as Parameters<typeof testCheck>[0])
  requireOneSelector("Cargo.Test", attrs, crateSelectors)
  return packageTestDefinition(attrs as (typeof PackageTestAttrs)["~type.make.in"])
}

/**
 * The crate selection one declaration fixes on its own, or undefined when the
 * planner has to expand a crate set to find it.
 *
 * `Cargo.Fetch` names its manifest as a declared file, so its selection is
 * that manifest; `workspace: true` and `package: "<name>"` are the two
 * selectors a declaration settles by itself.
 *
 * @category accessors
 * @since 0.1.0
 */
export const selectionOf = (attrs: unknown): CrateSelection | undefined => {
  const values = (typeof attrs === "object" && attrs !== null ? attrs : {}) as Record<string, unknown>
  const workspace = values["workspace"]
  if (workspace === true) return { _tag: "Workspace" }
  if (
    typeof workspace === "object" && workspace !== null &&
    (workspace as { readonly _tag?: unknown })._tag === "File" &&
    typeof (workspace as { readonly path?: unknown }).path === "string"
  ) return { _tag: "Manifest", path: (workspace as { readonly path: string }).path }
  if (typeof values["package"] === "string") return { _tag: "Package", name: values["package"] }
  return undefined
}
