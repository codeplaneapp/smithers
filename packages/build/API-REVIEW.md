# smithers build API review

## Read in this order

1. `BUILD.ts` shows the declared toolchain, the declared secrets, the
   generated root files, the real install target, shared root inputs, and the
   workspace default-rule declaration.
2. `packages/engine/BUILD.ts` shows `StandardPackage` plus one extra
   policy target. `packages/flow/BUILD.ts` shows the same package
   longhand. `packages/plan/BUILD.ts` shows the bare macro.
3. `packages/targets/src/StandardPackage.ts` expands a conventional package into `lib`,
   `test`, and `lint`.
4. `packages/targets/src/Target.ts` defines `Target.make`. Attrs are an Effect Struct schema.
   The implementation is the required pure Flow body. A rule call returns a
   Flow with planner metadata attached.
5. `packages/targets/src/TsBuild.ts` is a representative catalog rule.
   `packages/targets/src/LlmLint.ts` shows a git diff as declared key material.
6. `packages/targets/src/Config.ts` is the inert workspace configuration declaration the
   root BUILD.ts file exports.
7. `packages/build-cli/src/Cli.ts` defines the incur verbs. `packages/build-cli/src/Workspace.ts` handles lazy
   BUILD.ts loading and cache-directory resolution. `packages/build-cli/src/Planner.ts`
   constructs the target graph and key preview. `packages/build-cli/src/engine.ts` isolates
   install-runtime assumptions.

## Workspace configuration

The root BUILD.ts file may export one `Workspace({ cacheDirectory,
gitignored })` value. It is inert: the constructor validates and performs no
I/O. Every command resolves the cache directory as `--cache-dir`, then the
declaration, then `.flows`, and applies the declared gitignore policy before
touching the directory.

The resolved directory is host state, never attrs and never key material.
Discovery, the recursive fallback listing, and glob expansion all exclude it
unconditionally. Manager store paths stay fixed at `.flows/store/<manager>`
and are excluded independently because they are declared `TreeArtifact`
boundaries; configurable store placement is future work.

## Labels

Labels come only from a BUILD.ts path and named export.

- `//path/to/pkg:target` addresses one named export.
- `//path/to/pkg` selects the package default. The current convention tries
  `lib`, `nodeModules`, the package basename, `default`, then a sole export.
- `//...` selects every discovered BUILD.ts target.
- `//path/...` selects a subtree.
- `:target` selects an export in the current package.
- The root install target is `//:nodeModules` and `//` selects it by default.

Direct imports form dependency edges. Labels never appear in rule attrs.
`glob()` and `file()` create declared values and perform no I/O during module
evaluation. The planner expands and digests them later.

## Execution status

Every catalog rule is implemented. No rule ends in `NotImplemented`; only the
`Target.ts` stub machinery remains, for future catalog additions.

Every tool-running rule takes the declared package manager as a required attr
and derives its argv from it. Rules that evaluate an inline program take the
declared runtime instead. Nothing in the catalog spells `pnpm` or `node` into
an argv of its own.

`build`, `test`, and `lint` execute their plans by default. The executor runs
targets in dependency order with bounded parallelism (`--jobs`), keep-going
semantics (a failure skips only its dependent cone), and per-target cache
lookups keyed by the planner key preview. Green cacheable results are stored
in the workspace cache under `<cacheDirectory>/cache` or the HTTP `/ac` remote
declared by `RemoteCache`; `SMITHERS_CACHE_URL` overrides its endpoint and
`--no-cache` bypasses reads while still writing.
`--plan` prints the inert structured plan instead of executing. `ci` merges
the build, test, and lint plans over one pattern. `query` and `graph` stay
inert. `smithers-build install` plans and executes the `Install.Install` Flow over the layer
the declared toolchain selects; the root `Install` target calls the same Flow
with the declared manager as its payload. The executor derives both the
package-manager layer and the runtime layer from each target's own attrs, so
two targets in one graph may run under different managers.

The CLI process entry point captures `SMITHERS_CACHE_URL` and the default
`SMITHERS_CACHE_TOKEN` once during startup and deletes both from `process.env`.
That is a choice only a process owner may make; the programmatic `makeCli`
surface reads the declared token variable and never deletes it, because two
concurrent callers would otherwise erase each other's credentials. The root
declaration carries only an endpoint and token environment-variable name. The
shared exec runner removes both the URL override and the resolved token
variable after merging a payload's environment, so a target cannot reintroduce
either capability and a declaration's custom token variable never reaches a
tool child.

Exec working directories and generated-file paths are confined to the
canonical workspace root. Lexical escapes, absolute paths outside the root,
and paths crossing an in-workspace symlink to an outside location fail with a
typed execution or drift error. Exec streams output live while retaining only
a bounded head and tail, includes stdout and stderr tails in failures, and
interrupts the detached child process group when the CLI receives SIGINT or
SIGTERM.

Every key carries the rule implementation digest, Node version, platform,
architecture, and workspace `pnpm-lock.yaml` digest. `EXECUTION_FORMAT` in
`packages/build-cli/src/Planner.ts` is the global executor-semantics salt. Increment it when
executor behavior changes without otherwise changing key material.

Each target executes through a fresh in-memory flows runtime because two
targets of one rule share a Flow tag (open question 1). A rule that chains two
keyless `Exec` steps passes the first step's planned result through the second
payload's `after` field. That reference is a material dependency the engine
settles before dispatch; without it both keyless execs dispatch at once and
the engine refuses with `ConcurrentKeylessDispatch`. `captureOutputs` takes
the producing step's planned result for this reason.

Default-rule target synthesis is implemented. A directory that matches the
declaration's glob, contains the marker file, and lacks a BUILD.ts file
synthesizes the macro's targets, and the macro receives `cwd: <directory>`
beneath its declared attrs. Every tool-running rule has a `cwd` attr
defaulting to the workspace root; package-level BUILD.ts targets pass their
own package directory.

Release targets carry planner-level verb gates. npm and JSR publication, plus
Changesets versioning, may appear only in a `run` graph. The planner checks
every visited target, so a build, test, or lint target cannot smuggle a release
operation in through a dependency. Changesets status has no gate and remains
safe for read-only validation graphs.

Generated package manifests and GitHub workflows resolve their declared
check-mode input and their read or write action from the same workspace-rooted
path. GitHub workflow generation emits one compact `ci` command for the exact
build, test, and lint set, and otherwise emits one command per declared kind.

## Known limitations

- artifact store not yet wired; hits are validated, not materialized.
- Environment variables stay out of keys for now.
- General closure problem (tsconfig extends chains, config imports,
  gitignored-but-compiled files).

## Open API questions

1. A target is currently a Flow tagged by rule id, plus symbol metadata. Two
   `TsBuild` targets therefore share a Flow tag even though their target labels
   differ. The executor works around it with a fresh runtime per target.
   Decide whether the loader should bind a path-derived Flow tag after
   export discovery or whether target identity should remain outside Flow.
2. A rule call cannot know its export name. Metadata captures the BUILD.ts
   call-site path from the stack so the lazy loader can find a direct imported
   dependency without evaluating unrelated modules. Decide whether this hint
   is acceptable or whether the runtime needs a loader-owned module registry.
3. Synthesized package defaults declare no dependency edges: the default-rule
   declaration passes one static `attrs` value (`deps: []`) to every match.
   Decide how synthesized packages infer edges to each other, for example from
   package.json workspace dependencies.
4. Decide whether `StandardPackage` should expose `typecheck`, declaration
   build, and formatting as separate targets or keep the review surface at
   exactly `lib`, `test`, and `lint`.
5. Key previews carry `body`, `inputs`, `layers`, and `capabilities`, and the
   preview digest is now the executor's cache key. Layer and capability lists
   are still hand-maintained catalog declarations in `packages/build-cli/src/Planner.ts`.
   Executable rules should eventually derive them from the real Flow graph and
   resolved Layers.
6. Source distributions use a JavaScript bin bootstrap plus tsx to evaluate
   TypeScript. Decide whether the published CLI ships compiled JavaScript while
   retaining tsx only for BUILD.ts evaluation.

## Install-package seam

`packages/targets/src/Install.ts` and `packages/build-cli/src/engine.ts`
are reconciled against the current install package: the Install payload is
`{ manager }`, the workspace root is the engine's working directory, and the
executor and `runInstall` move there through `withWorkingDirectory`. All
CLI-side runtime assumptions stay confined to
`packages/build-cli/src/engine.ts`.

The duplication that used to sit here is gone. The rule declares the lockfile,
`.npmrc`, and root manifest as its own inputs, and the Flow no longer measures
the manager it runs under: the manager is the BUILD.ts declaration, and the
services hold the host to it.
