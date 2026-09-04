# @smthrs/registry

This package declares `effect` as an exact
`4.0.0-rc.108` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://registry.smithers.sh

Portable flow descriptor discovery and progressive-disclosure registry services. It scans ordered filesystem sources into serializable metadata, keeps prompt bodies lazy, and exposes lookup, disclosure, and execution to a host without evaluating modules during discovery.

```sh
npm install @smthrs/registry
```

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/registry/<Module>`.

| Module          | What it owns                                                                               |
| --------------- | ------------------------------------------------------------------------------------------ |
| `Descriptor`    | The serializable descriptor, body, schema, source, provenance, budget, and warning models. |
| `Disclosure`    | Projects descriptors to compact entries or Agent Skills XML.                               |
| `Discovery`     | Metadata-only source scanning over `FileSystem` and `Path`.                                |
| `Executable`    | Turns a discovered descriptor into a registered, engine-runnable `@smthrs/flow` flow.      |
| `MarkdownFlow`  | Parses markdown metadata, loads prompt bodies lazily, and renders invocation prompts.      |
| `Pack`          | Reads pack manifests, addresses their contents, and merges packs by origin.                |
| `Registry`      | Ordered discovery, lookup, visibility, lazy body loading, refresh, and warnings.           |
| `RegistryError` | Typed discovery and registry failures and their constructors.                              |

Every export of every namespace, with signatures and errors, is on
https://registry.smithers.sh/reference/api/. That page is the reference; this
file is the orientation.

## Discovering a project's flows

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer } from "effect"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const discovery = Discovery.layer.pipe(Layer.provide(platform))

const registry = Registry.layer({
  sources: [{ source: "project", root: "flows", naming: "path" }]
}).pipe(Layer.provide([discovery, platform]))

const program = Effect.gen(function*() {
  const catalog = yield* Registry.Registry
  return yield* catalog.list()
}).pipe(Effect.provide(registry))
```

Scanning a source parses markdown frontmatter and module metadata without
evaluating a module or reading a prompt body, so a catalog of a thousand flows
costs a thousand frontmatter parses and no imports. Each descriptor records the
SHA-256 of the bytes the scan read, and a body loaded later is checked against
it.

Use `Registry.layerFromDescriptors(entries)` for an in-memory snapshot with lazy
body access, and `Registry.layerNoop()` for a composition that has no registry
and must say so. `@smthrs/registry/package.json` is also exported; `internal/*`
and nested `*/index` subpaths are blocked.

## Running a discovered flow

`Executable` loads the body a descriptor points at, resolves the
`@smthrs/flow` flow the descriptor delegates to, and returns a durable flow
plus the `Interpreter` layer that registers it.

```ts
import { Action } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Executable } from "@smthrs/registry"
import { Layer } from "effect"

const registration = Executable.layer({ delegates: [Agent, Shell] }).pipe(
  Layer.provideMerge(Action.layerImplementations)
)

const host = NodeRuntime.layerHost(
  {
    filename: ".flows/engine.db",
    workspaceRoot: process.cwd(),
    owner: { hostId: "local" }
  },
  registration,
  Executable.layerProject({ root: process.cwd() })
)
```

A descriptor declares what it delegates to in its `flows` field. One named flow
is the delegate; no named flow, or several plus a declared `model`, delegates to
the agent driver, whose name defaults to `Executable.defaultAgent`; several
named flows and no model is
`ExecutableError { code: "ambiguous_delegate" }`. A delegate no host registered
is `missing_delegate`, raised while the executable is being built rather than at
dispatch, naming the missing flow and listing what is registered.

Every delegate receives the same serializable `Invocation` envelope, so one
registered driver runs many descriptors. `Executable.catalog` reports every
refusal instead of raising it, because one mid-edit file under `flows/` must not
take every unrelated command down with it.

## Workflow packs

A pack is a directory with a `pack.json` manifest, the shareable unit a project
installs rather than copies.

```ts
import { Registry } from "@smthrs/registry"

const packs = Registry.layerFromPacks(
  [
    { manifest: projectManifest, dir: "/repo/.flows/review-pack", origin: "local" },
    { manifest: vendoredManifest, dir: "/repo/node_modules/review-pack", origin: "installed" }
  ],
  { runtimeVersion: "1.0.0" }
)
```

Precedence is the pack's origin rather than the caller's order, every pack's
`requires.smithers` range is checked before anything is scanned, and every
contributed source is confined to its pack root. Every descriptor a pack
contributes carries `provenance.pack`, so a catalog entry says where it came
from.

The `pack add | remove | list | update | eject` CLI verbs are not part of this
package. This is the runtime contract underneath them.
