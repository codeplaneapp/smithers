# FAQ

## Is `BUILD.ts` really just TypeScript?

Yes. The CLI imports it through the programmatic `tsx` loader with
`tsconfig: false`. Every named export is inspected. Exports that are targets
become labels, exports that are `Workspace` or `PackageDefaults` declarations become
workspace configuration, and everything else is ignored.

One constraint follows from the loader. `tsconfig: false` means no tsconfig is
read, so compiler options declared in the workspace do not apply: a `paths` alias
does not resolve, and a relative import names the real file, extension included,
as in `import { lib } from "../plan/BUILD.ts"`.

## Can a target call read the filesystem?

No. `Target.make` requires a pure plan-time body: it records plan nodes and
executes nothing. `file()`, `glob()`, and `gitDiff()` return inert values. The
planner expands and digests them during discovery. See
[Inputs](../concepts/inputs.md).

## How do I reference another target?

Import it.

```ts
import { lib as plan } from "../plan/BUILD.ts"

export const lib = TsBuild({ packageManager, deps: [plan] /* ... */ })
```

Labels never appear in target attributes. A target value found anywhere inside an
attrs object becomes a dependency edge. See
[Dependencies](../concepts/dependencies.md).

## What are `run` and `docs` for?

`run` selects operational targets that should never be pulled into ordinary
build, test, lint, or CI selection. Examples are cleaning, watch processes,
package scaffolding, and generated-file writes. `NewPackage` receives its name
through `smithers-build run <label> --name <package>`.

`docs` selects documentation targets standalone. The same targets are also part
of `ci`, whose merged graph plans lint, build, test, and docs.

## Which targets actually execute?

The CLI executor supplies implementations for process execution, output
capture, filegroups, generated files, package-manifest synchronization,
workflow and documentation checks, LLM review, package scaffolding, and the
pnpm install actions. The irreversible-exec layer is intentionally absent, so
`NpmPublish`, `JsrPublish`, and the `version` operation of `Changesets` fail
with an `unresolved_action` refusal. The per-target status is on each page under
[Target catalog](../reference/targets/README.md), and the summary table is in
[Running targets](../workspace/running-targets.md).

## Are actions sandboxed?

No. `ExecLive` spawns the tool with `node:child_process` in the workspace, with
`process.env` merged under the payload `env`. Declared effects exist in the
action declarations, and the Smithers filesystem boundary can capture and replay a
declared `TreeArtifact`, but nothing proves that a process wrote nowhere else.
See [Actions and boundaries](../concepts/actions-and-boundaries.md).

## Is `node_modules` cached?

No. `Install` splits into fetch and link, and both use `expected` boundaries.
Fetch populates `.flows/store/<manager>` but is not admitted to a cross-run
engine cache because the current child-process boundary cannot freeze its
lockfile/configuration inputs or prove hermetic reads. Link materializes
`node_modules` locally and always reconciles it. A `node_modules` tree is a
graph of links into a host-local store, so restoring one from another machine
would produce a tree pointing at nothing. See
[Install](../concepts/install.md).

## Why do two targets of the same target need separate runtimes?

A target is a flow tagged by target id. Two `TsBuild` targets share that tag, so
registering both with one engine would alias their bodies. The executor gives
each target a fresh in-memory runtime. `API-REVIEW.md` records this as an open
API question.

## Does `--plan` tell me whether a target is cached?

No. Planner output still reports `cacheLookup: "not-wired"` and `wouldRun: true`
for every target. The planner computes the content key but consults no cache. The
executor performs the lookup. See [Caching](../workspace/caching.md).

## Does the cache directory affect cache keys?

No, by design. The resolved cache directory is host state. Discovery never lists
a path inside it, declared globs never expand into it, and its name never reaches
a cache key or a content digest. `DepsLint` writes a generated config under it
using a plan-time token that the exec layer substitutes immediately before spawn.
See [Configuration](../workspace/configuration.md).

## Can I move the package-manager store?

Not today. Manager stores stay at `.flows/store/<manager>` regardless of
`cacheDirectory`. The direct `install` command therefore rejects a custom cache
directory instead of declaring one path and writing another. Other target verbs
may use a custom directory. Supporting configurable install stores requires the
declaration and host-state substitution to change together.
