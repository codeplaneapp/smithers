---
title: "Discover a project's flows"
description: "Build a registry from ordered filesystem sources, read the catalog it produced, refresh it after an edit, and choose the right constructor for the host you are writing."
sidebar:
  order: 1
---

`Registry.layer(config)` is the constructor for a host that scans real
directories. It takes the sources in caller order, scans each one through
`Discovery`, and holds the merged result as one snapshot.

## Provide the platform, then discovery, then the registry

`Discovery` is written against `effect`'s portable `FileSystem` and `Path`, so
the host decides what "the filesystem" means. On Node:

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import type * as RegistryError from "@smthrs/registry/RegistryError"
import * as Layer from "effect/Layer"
import { join } from "node:path"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const discovery = Discovery.layer.pipe(Layer.provide(platform))

export const layerRegistry = (root: string): Layer.Layer<
  Registry.Registry,
  RegistryError.RegistryFailure
> =>
  Registry.layer({
    sources: [{ source: "project", root: join(root, "flows"), naming: "path" }]
  }).pipe(Layer.provide([discovery, platform]))
```

The registry layer needs `FileSystem` and `Path` for itself, not only for
discovery: `loadBody` reads the body on demand long after the scan finished.
Providing the platform to both is why it appears twice.

## Order the sources deliberately

The first descriptor to claim a name keeps it, so the order of `sources` is the
precedence. The canonical order is system, project, plugin, then foreign
sources:

```ts
const sources = [
  { source: "system", root: systemRoot, naming: "path", system: true },
  { source: "project", root: join(root, "flows"), naming: "path" },
  { source: "skills", root: join(home, ".claude/skills"), naming: "frontmatter" }
] as const
```

`system: true` changes the collision rule rather than the order: a name shared
with a system source fails construction with
`RegistryError { code: "system_collision" }` instead of being resolved
silently. Two ordinary sources sharing a name resolve first-found and report a
`duplicate_name` warning. See [Sources and naming](../concepts/sources.md).

## Decide what a missing root means

A source root that does not exist fails the scan with
`DiscoveryError { code: "root_missing" }`, and the registry layer fails with it.
That is usually the wrong outcome for a project's own `flows/` directory,
because a project that has not created one yet simply has no flows. Catch that
one code, and let every other discovery failure stay a startup defect:

```ts
import * as Effect from "effect/Effect"

const registry = Registry.layer({ sources }).pipe(
  Layer.provide([discovery, platform]),
  Layer.catch((error) =>
    error.code === "root_missing"
      ? Registry.layerFromDescriptors([]).pipe(Layer.provide(platform))
      : Layer.effect(Registry.Registry)(Effect.die(error))
  )
)
```

This is what the Smithers CLI does. `Executable.layerProject` makes the same
decision a different way, by asking whether the directory is there before
scanning, which keeps "this project has no flows" from swallowing a pack that
declares a directory it does not ship. See
[Run a discovered flow](./run-a-discovered-flow.md).

## Read the catalog

The service has eight members, and only two of them touch the filesystem:

| Member                      | What it answers                                           |
| --------------------------- | --------------------------------------------------------- |
| `list()`                    | Every descriptor, in first-found order.                   |
| `visible()`                 | The descriptors a model may be shown.                     |
| `get(name)`                 | One descriptor, or `RegistryError { code: "not_found" }`. |
| `getOption(name)`           | One descriptor as an `Option`, never failing.             |
| `loadBody(name)`            | The body, read and digest-checked on demand.              |
| `runPrompt(name, { args })` | A markdown body rendered as a prompt.                     |
| `refresh()`                 | Rescans every source and replaces the snapshot.           |
| `warnings()`                | Every discovery and collision diagnostic.                 |

```ts
const report = Effect.gen(function*() {
  const catalog = yield* Registry.Registry
  const entries = yield* catalog.list()
  const warnings = yield* catalog.warnings()
  return { flows: entries.length, diagnostics: warnings.length }
})
```

Every read observes one complete snapshot, so a `list` and the `get` after it
never disagree.

## Refresh after an edit

`refresh()` rescans every configured source and replaces the snapshot only
after all of them succeed, so a failed rescan leaves the previous complete
snapshot serving reads rather than emptying the catalog.

Refresh is also what adopts an edited body. A descriptor records the SHA-256 of
the bytes the scan read, and `loadBody` refuses with `body_unavailable` when the
file changed since. That refusal is the signal to refresh, not a reason to skip
the check:

```ts
const runAfterEdit = Effect.gen(function*() {
  const catalog = yield* Registry.Registry
  yield* catalog.refresh()
  return yield* catalog.runPrompt("review", { args: "" })
})
```

## Pick the right constructor

| Constructor                                          | Use it when                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Registry.layer(config)`                             | The host scans real directories.                                                     |
| `Registry.layerFromPacks(packs, { runtimeVersion })` | The catalog is a set of installed packs. See [Load workflow packs](./load-packs.md). |
| `Registry.layerFromDescriptors(entries, warnings?)`  | The host already holds descriptors and still wants lazy body loading.                |
| `Registry.layerNoop(overrides?)`                     | The composition has no registry and must say so.                                     |
| `Registry.make(config)`                              | The host needs the service value rather than a layer.                                |

`layerNoop` and `makeNoop` are explicit absences, not empty catalogs by
accident: every member fails or answers empty, and `overrides` replaces the
members a test cares about. See [Test against a registry](./testing.md).
