---
title: "@smthrs/registry"
description: "Flow discovery and the catalog a model is shown: portable descriptors scanned off a filesystem, disclosed to an agent in a compact form, and resolved back to a runnable flow on demand."
---

`@smthrs/registry` answers two questions about a directory of flows: what is in
it, and how one of them runs.

A **descriptor** is the first answer. Scanning a source parses markdown
frontmatter and module metadata without evaluating a module or reading a prompt
body, so a catalog of a thousand flows costs a thousand frontmatter parses and
no imports. Every descriptor is serializable, and it records the SHA-256 of the
bytes the scan read, so the body it points at can be loaded later and checked
against what the catalog describes.

An **executable** is the second answer. `Executable` loads that body, resolves
the `@smthrs/flow` flow the descriptor delegates to, and returns a durable flow
plus the layer that registers it with the runtime. A delegate no host
registered is refused while the executable is built, naming the missing flow,
rather than dying inside the engine at dispatch.

## Who uses this package

Hosts and CLIs use `Registry` and `Executable` to turn a project's `flows/`
directory into a catalog they can list, launch, and refresh.
[`@smthrs/agent`](/api/agent) uses the same registry to decide which flows a
model may call, and `Disclosure` to render the catalog it is shown.

## Install

```bash
pnpm add @smthrs/registry
```

For the peer packages a real composition adds, see
[Installation](./installation.md).

## The shortest real example

Two layers scan a project's `flows/` directory and answer from the snapshot:

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const discovery = Discovery.layer.pipe(Layer.provide(platform))

const registry = Registry.layer({
  sources: [{ source: "project", root: "flows", naming: "path" }]
}).pipe(Layer.provide([discovery, platform]))

const names = Effect.gen(function*() {
  const catalog = yield* Registry.Registry
  return (yield* catalog.list()).map((entry) => entry.name)
}).pipe(Effect.provide(registry))
```

For the whole task, including the flow file the scan reads and the prompt it
renders, see the [Quickstart](./quickstart.md).

## The package at a glance

The root entry point exports these namespaces, and each is also importable from
`@smthrs/registry/<Module>`:

| Namespace       | What it owns                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Descriptor`    | The serializable `FlowDescriptor` and every value it is built from: schema references, body references, effects, provenance, budgets, and discovery warnings. |
| `Discovery`     | The `Discovery` service that walks one source root and returns a `SourceScan`.                                                                                |
| `MarkdownFlow`  | Markdown and Agent Skills compatibility: frontmatter to descriptor, body loading, and prompt rendering.                                                       |
| `Registry`      | The refreshable, first-found-wins catalog a host consumes, plus its layers.                                                                                   |
| `Disclosure`    | The compact projections a model and a slash-autocomplete list are shown.                                                                                      |
| `Executable`    | Turning one descriptor into a runnable `@smthrs/flow` value, and the `Invocation` envelope a delegate receives.                                               |
| `Pack`          | Manifests, content addresses, compatibility ranges, and the precedence rules a shareable pack brings.                                                         |
| `RegistryError` | `DiscoveryError` and `RegistryError`, their stable codes, and their constructors.                                                                             |

Every export of every namespace, with signatures and errors, is on the
[API reference](./api.md).

## Where to go next

- [Installation](./installation.md): requirements, import forms, and the
  packages a runnable composition adds.
- [Quickstart](./quickstart.md): scan a flows directory, read the catalog, and
  render a prompt.
- Concepts: [descriptors](./concepts/descriptors.md),
  [sources and naming](./concepts/sources.md),
  [declared authority](./concepts/authority.md), and
  [delegation](./concepts/delegation.md).
- Guides: [discover a project's flows](./guides/discover-a-project.md),
  [diagnose a flow that did not appear](./guides/diagnose-a-missing-flow.md),
  [run a discovered flow](./guides/run-a-discovered-flow.md),
  [reuse a discovered flow's result](./guides/reuse-a-flow-result.md),
  [show a catalog to a model](./guides/show-flows-to-a-model.md),
  [load workflow packs](./guides/load-packs.md), and
  [test against a registry](./guides/testing.md).
- [Troubleshooting](./troubleshooting.md): the typed failures this package
  reports, what causes them, and what to change.
