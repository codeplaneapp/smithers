# @smthrs/registry

Portable flow descriptor discovery and progressive-disclosure registry services. It scans ordered filesystem sources into serializable metadata, keeps prompt bodies lazy, and exposes lookup and rendering to the harness without evaluating modules during discovery.

```sh
npm install @smthrs/registry
```

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/registry/<Module>`.

| Module          | Public exports                                                                                                                                                                                                                                                                                                                                                    | Description                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Descriptor`    | `EffectTier`, `Placement`, `EffectDeclaration`, `SchemaRefMarkdownArgs`, `SchemaRefMarkdownOutput`, `SchemaRefModule`, `SchemaRefNone`, `SchemaRef`, `BodyRefMarkdown`, `BodyRefModule`, `BodyRef`, `FlowBodyPrompt`, `FlowBodyModule`, `FlowBody`, `PackRef`, `Provenance`, `Source`, `DiscoveryWarningCode`, `DiscoveryWarning`, `FlowDescriptor`, `SourceScan` | Defines the serializable descriptor, body, schema, source, provenance, and warning models. |
| `Disclosure`    | `toEntries`, `toXml`                                                                                                                                                                                                                                                                                                                                              | Projects descriptors to compact entries or Agent Skills XML.                               |
| `Discovery`     | `Discovery`, `make`, `layer`, `makeNoop`, `layerNoop`                                                                                                                                                                                                                                                                                                             | Defines and implements metadata-only source scanning over FileSystem and Path.             |
| `Executable`    | `defaultAgent`, `Payload`, `Invocation`, `Delegate`, `ExecutableErrorCode`, `ExecutableError`, `Lowered`, `Registration`, `Executable`, `Options`, `fileSpecifier`, `delegateOf`, `lower`, `fromDescriptor`, `fromRegistry`, `Catalog`, `catalog`, `layer`, `ProjectOptions`, `layerProject`                                                                      | Turns a discovered descriptor into a registered, engine-runnable `@smthrs/flow` flow.      |
| `MarkdownFlow`  | `Input`, `Output`, `FromMarkdownOptions`, `FromMarkdownResult`, `fromMarkdown`, `loadBody`, `renderPrompt`, `toCoreFrontmatter`                                                                                                                                                                                                                                   | Parses Markdown metadata, loads prompt bodies lazily, and renders invocation prompts.      |
| `Pack`          | `Origin`, `Requires`, `Manifest`, `Installed`, `File`, `Scan`, `read`, `digest`, `compatible`, `sources`, `attribute`, `merge`, `checkCompatible`                                                                                                                                                                                                                 | Reads pack manifests, addresses their contents, and merges packs by origin.                |
| `Registry`      | `Config`, `PackConfig`, `Registry`, `make`, `layer`, `layerFromDescriptors`, `layerFromPacks`, `makeNoop`, `layerNoop`                                                                                                                                                                                                                                            | Provides ordered discovery, lookup, visibility, lazy body loading, refresh, and warnings.  |
| `RegistryError` | `DiscoveryErrorCode`, `DiscoveryError`, `RegistryErrorCode`, `RegistryError`, `RegistryFailure`, `discoveryError`, `registryError`                                                                                                                                                                                                                                | Defines typed discovery and registry failures and constructors.                            |

```ts
import { Registry } from "@smthrs/registry"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const registry = yield* Registry.Registry
  return yield* registry.list()
}).pipe(Effect.provide(Registry.layerNoop()))
```

Use `Discovery.layer` with `Registry.layer(config)` for filesystem discovery, or `Registry.layerFromDescriptors(entries)` for an in-memory snapshot with lazy body access. `@smthrs/registry/package.json` is also exported; `internal/*` and nested `*/index` subpaths are blocked.

## Running a discovered flow

Discovery answers _what flows exist_. `Executable` answers _how one runs_: it
loads the body a descriptor points at, resolves the `@smthrs/flow` flow the
descriptor delegates to, and returns a durable flow plus the `Interpreter`
layer that registers it.

```ts
import { Action } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Executable } from "@smthrs/registry"
import { Layer } from "effect"

const registration = Executable.layer({ delegates: [Agent, Shell] }).pipe(
  Layer.provideMerge(Action.layerImplementations)
)

const runtime = NodeRuntime.layerHost(
  { filename: ".flows/engine.db", owner: { hostId: "local" } },
  registration,
  Executable.layerProject({ root: process.cwd() })
)
```

A descriptor declares what it delegates to in its `flows` field — a markdown
`flows:` frontmatter list, a module `Flow.make({ flows })`. The rules are:

- one named flow is the delegate;
- no named flow, or several plus a declared `model`, delegates to the agent
  driver, whose name defaults to `Executable.defaultAgent` and is renamed with
  `Options.agent`;
- several named flows and no model is `ExecutableError { code: "ambiguous_delegate" }`.

A delegate no host registered is `ExecutableError { code: "missing_delegate" }`,
raised while the executable is being built rather than at dispatch, and it names
the missing flow and lists what is registered.

Every delegate receives the same serializable `Invocation` envelope — the flow's
name, the caller's input, the rendered prompt, the declared seat, the placement
directive, the declared capabilities, and the declared collaborator flows — so
one registered driver runs many descriptors.

Three declarations are lowered onto the runtime:

| Declared on the body                                                                              | Lowered onto                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CacheEnvironment.CachePolicyAnnotation` (what `@smthrs/patterns`' `withCache` writes)            | the action the bridged flow dispatches, which is what `@smthrs/engine-store` reads a policy off; also the delegating node's captured key material and the flow's own annotation bag |
| `Annotations.Priority`                                                                            | the delegating node's `Node.priority`, which becomes `NodeDraft.priority` for `@smthrs/engine-store`'s `PlanScheduler`                                                              |
| `Flow.within(...)`, or the descriptor's own `"use sandbox"` directive or `placement:` frontmatter | the flow's `@smthrs/flow` placement annotation and the `Invocation.placement` a host selects a spawn target with                                                                    |

Read the table with these limits, which the suites pin as behavior rather than
as intent:

- **A cache policy changes the shape of the plan.** Without one, the delegate's
  own node goes into the plan the engine builds, so its fan-out, its priorities,
  and its waits are the caller's plan. That is many steps, and there is nothing
  in it for a policy to govern. Declaring a policy asks for one recorded unit
  instead, so the bridge dispatches a single action and runs the delegate
  underneath it as a child execution. `ttlMs` then bounds the age of the row the
  engine may serve, and `scope` narrows the address it is stored under.
- **The engine reuses a `sealed` dispatch and nothing else.** A descriptor that
  names a delegate flow inherits authority discovery cannot read, so it projects
  the conservative wildcard and its effective tier is `irreversible`: its policy
  reaches admission and is refused there. The descriptor whose result travels is
  the one whose own `capabilities` project a `sealed` tier, with a `hermetic`
  effect declaration and no globbed read set. Anything else would let a flow
  with unbounded authority declare its own result reusable.
- **The priority orders scheduled plans.** `PlanScheduler` admits ready nodes
  highest-priority-first under a concurrency limit. The `up` path settles a flow
  through `@smthrs/flow` `Interpreter`, which admits every ready node at once,
  so on that path the priority orders nothing.

`Executable.catalog(options)` builds every discovered flow this host can run and
reports the rest in `refused`, each carrying its `ExecutableError` code: a
delegate only another host registers (`missing_delegate`, `ambiguous_delegate`)
and a defect in the entry itself (`body_unavailable`, `invalid_module`) are both
reported rather than raised. `flows/` is a directory a person edits, so one file
in it is routinely mid-edit or wrong, and failing the catalog would take `ls`,
`ps`, and every unrelated `up` down with it.

`Executable.layer(options)` registers everything runnable, logs a warning naming
each refusal, and provides the whole `Catalog` as a service, so a host can print
what it declined instead of letting an operator find out from `up <flow>`.

`Executable.layerProject({ root, packs })` is the registry a Node host discovers
a project in: `<root>/flows/**` first, then every installed pack, under one
refreshable first-found registry. A project with no `flows/` directory has no
flows yet, which is the state `smithers init` leaves behind. A pack that
declares a flows directory it does not ship is a broken installation and fails
the layer as `RegistryError { code: "invalid_pack" }` naming the pack.

## Workflow packs

A pack is a directory with a `pack.json` manifest, the shareable unit a project installs rather than copies:

```json
{
  "name": "review-pack",
  "version": "1.2.0",
  "flows": ["flows"],
  "skills": ["skills"],
  "requires": { "smithers": ">=1.0.0" }
}
```

`Pack.read(fs, path, dir)` decodes one manifest and fails `RegistryError { code: "invalid_pack" }` when it is missing, unparseable, or incomplete. `Pack.digest(manifest, files)` is the content address a lock file records: it covers the manifest and every measured file by its own hash under its pack-relative path, so re-reading the same bytes in a different order produces the same digest and editing a flow body changes it.

`Registry.layerFromPacks(packs, { runtimeVersion })` scans a set of packs into one registry:

```ts
import { Discovery, Pack, Registry } from "@smthrs/registry"
import { Effect, Layer } from "effect"

const registry = Registry.layerFromPacks(
  [
    { manifest: projectManifest, dir: "/repo/.flows/review-pack", origin: "local" },
    { manifest: vendoredManifest, dir: "/repo/node_modules/review-pack", origin: "installed" }
  ],
  { runtimeVersion: "1.0.0" }
).pipe(Layer.provide(Discovery.layer))
```

Three rules govern the merge:

- **Precedence is the origin, not the list order.** Every `local` pack outranks every `installed` one, so a project pack shadows a vendored flow of the same name wherever the host listed it.
- **A shadowed flow is reported, not dropped silently.** The loser becomes a `DiscoveryWarning { code: "shadowed" }` naming both packs and versions, readable through `registry.warnings()`.
- **Compatibility is checked before anything is scanned.** A pack whose `requires.smithers` range this runtime does not satisfy fails `RegistryError { code: "incompatible_pack" }` at load rather than at the first call into one of its flows. The range grammar is `*`, an exact version, and the `>=`, `>`, `<=`, `<`, `^`, `~` comparators, space-separated as a conjunction. `^` and `~` read the way npm reads them: `^` allows everything up to the next bump of the left-most non-zero field, so `^1.2.0` accepts `1.9.0` while `^0.2.3` refuses `0.9.0` and `^0.0.3` accepts only `0.0.3`. A range the parser cannot read is refused rather than assumed compatible.

Every descriptor a pack contributes carries `provenance.pack` with the pack name, version, and origin, so a catalog entry says where it came from.

The `pack add | remove | list | update | eject` CLI verbs are not part of this package. This is the runtime contract underneath them: it reads manifests from directories a caller names and holds no filesystem policy of its own.
