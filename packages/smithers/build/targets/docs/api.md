# The module surface

`@smthrs/targets` is the pure authoring surface a `PACKAGE.ts` or `PACKAGE.ts`
file writes against. Nothing here reads the filesystem or starts a process: a
target call validates its attrs, records its declared inputs and dependencies,
and returns a Flow with planner metadata attached. Execution belongs to
`@smthrs/build-cli`.

## Construction

`Target.make(id, options)` is the one constructor. It returns a `Definition`:
callable with attrs, and carrying `id`, the `attrs` schema, and the `kinds` it
participates in. Every catalog rule is a `Definition`, including the ones that
refuse something the schema cannot express; those are wrapped with
`Target.guard`, which runs the refusal first and keeps the definition's shape.

A declaration is read exactly once, as data. The author's object is snapshotted
before the schema sees it: a `Proxy` is refused, an accessor is refused by name,
and a value with a non-plain prototype passes through as an opaque handle.
Everything the target then owns is frozen, so `Target.metadata(target)` and each
`forKind` view cannot be edited after the checks that validated them.

`Target.metadata` is the planner's view: the rule id, the schema identity, the
decoded attrs, the declared inputs, the dependency targets and selectors, the
declared output tree, and the verbs. `implementationDigest` is also there, and
is deliberately not identity: it digests function identity, which carries
per-process entropy for any callback not built with `Node.capture`.

## Declared inputs and outputs

`Input` declares what a target reads: `file`, `glob`, `gitDiff`, and
`pnpmWorkspace`. `Input.resolvePath` resolves one declaration against its
package directory, and `Input.rootRelative` renders a workspace-rooted `//`
path for a child running under a target's own `cwd`. A rule that renders a
declared path into argv uses the second one; stripping the `//` alone resolves
the path against the wrong directory whenever `cwd` is not the workspace root.

`DeclaredOutputs` is the complete tree a target promises one execution
produces. It is target metadata, not something read back out of an action
payload: an untrusted cache entry never chooses which paths are verified.
`ToolBuild.captureOutputs` digests them, and a tool that exits zero without
producing a declared output fails the target.

## Execution boundaries

`Exec` is the sealed action every tool run goes through. Its failures carry a
closed `code` (`invalid_payload`, `spawn_failed`, `timed_out`, `signaled`,
`stream_failed`, `secret_proxy_failed`, `exit_status`) and, for a signalled
child, the `signal` itself, so a caller decides what to do without parsing
stderr.

`SafeFs` is the confined filesystem seam: no-follow reads, bounded sizes, and
one meaning for absent. `GeneratedFile` writes and drift-checks a generated
file; its `DriftError` carries a `reason` of `missing`, `drifted`, or
`unreadable`, because only the first two are answered by regenerating.

`Secret` declares which environment variable holds a value and which origins may
receive it. `SecretProxy` is the execution half: it mints the placeholder a
child receives and substitutes the real value at the transport boundary, never
in argv or env. A value written into a request target is percent-encoded, and
every value the boundary resolved, plus a brokered destination URL, its origin,
and its request target, is rewritten back out of the response before the child
sees it.

`Outward` is the shared refusal gate for the five rules that push bytes to
somebody else's machine. It reads declarations only: a required credential the
declaration never names is refused here, and a variable that is declared but
unset is refused later, at the transport boundary.

## Composition

`Compose` holds the rules that are about other rules: `Generate` (check by
default, `--write` applies, and check mode restores the declared write set
including file type and permissions), `Suite`, `Alias`, `Materialize`, and
`Files.Test`. `StandardPackage` and `PackageDefaults` assemble the conventional
per-package target set, and `Smithers` is the single namespace a PACKAGE.ts file
imports.

`BunSuite` is the Bun half of that set: it re-runs one package's vitest suite
under Bun, with the interpreter named on the target rather than a second package
manager restated, and with coverage off because `@vitest/coverage-v8` needs V8's
inspector and Bun runs JavaScriptCore. A package declares it beside its
`StandardPackage` call under the conventional key `bunTest`, so the whole
runtime-compatibility matrix is the pattern `//packages/...:bunTest` and a
package's Bun claim lives with the package instead of in a central list. Its
JSDoc records which packages must not declare it and why.

`FaultSuite` is the fault-injection half. It runs one package's `test/faults`
tree under a second vitest config, `vitest.faults.config.ts`, whose
`fileParallelism` is `false`: a case `SIGKILL`s a pid, cuts a live socket, binds
an ephemeral port, or reads the machine's process table, and none of those can
be shared between two files on one machine. Coverage is off because the work
happens in child processes this one never instruments, so the package's `test`
target beside it stays the coverage gate. A package declares it beside its
`StandardPackage` call under the conventional key `faults`, which makes
`//packages/...:faults` the whole matrix; the target that pattern replaced was a
single `//e2e:faults` in a workspace member that owned every case in the
repository.

The emitted Vitest target carries `exclusive: true`, so wildcard `ci` and
`test` selections omit it regardless of its exported key. Select the matrix
explicitly with `smithers-build test '//packages/...:faults' --jobs 1`, or opt
a wildcard into all tiers with `--include-exclusive`. The executor drains ready
ordinary work first and runs each exclusive target alone, even with a larger
`--jobs` value. Dependencies keep their ordering. This isolates targets within
one invocation; independent invocations still need separate machines or external
coordination. A wildcard whose ordinary target depends on an exclusive target
refuses with an opt-in diagnostic instead of silently adding the fault suite.

`DurableIdentityGuard`, `DocsReferenceSync`, and `JsdocTruthfulness` are the
model-review macros. Each one bakes a rubric, the prompt framing, the engine,
the model tier, the batch size, and the failure threshold into an `LlmLint`,
and anchors its globs and its diff to the `cwd` the declaring package passes,
so a package opts into a review by declaring one target rather than by being
named in a list somewhere else.

See [`rules.md`](./rules.md) for the generated inventory of every rule.
