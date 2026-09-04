---
title: "Test against a registry"
description: "Substitute the registry rather than the code under test: the explicit noop seams, an in-memory descriptor snapshot, and the one seam that keeps a module-loading test off the filesystem."
sidebar:
  order: 7
---

Every service this package exposes ships an explicit absence, so a test
provides the smallest composition that type-checks and substitutes the seam
rather than the code under test.

## The noop seams

| Service     | Explicit absence                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `Registry`  | `Registry.makeNoop(overrides?)`, `Registry.layerNoop(overrides?)`. Every member fails `not_found` or answers empty. |
| `Discovery` | `Discovery.makeNoop(overrides?)`, `Discovery.layerNoop(overrides?)`. `scan` answers an empty `SourceScan`.          |

`overrides` replaces the members a test cares about and leaves the rest as the
absence, which is what makes the stub honest: a test that overrides `list` and
not `loadBody` still fails a body load rather than answering something invented.

```ts
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

const registry = Registry.makeNoop({
  list: () => Effect.succeed([]),
  visible: () => Effect.succeed([]),
  getOption: () => Effect.succeed(Option.none())
})
```

That is the value the repository's own agent hosts pass when a run must reach
no flows at all. `Registry.layerNoop()` requires nothing, so it composes into a
test that has no filesystem.

## An in-memory snapshot with real body loading

`Registry.layerFromDescriptors(entries, warnings?)` is the seam for a test that
needs real descriptors without a scan. It holds the snapshot in memory and
still loads bodies lazily, so `loadBody` and `runPrompt` behave exactly as they
do in production, including the digest check:

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Layer from "effect/Layer"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const registry = Registry.layerFromDescriptors([reviewDescriptor]).pipe(Layer.provide(platform))
```

Its `refresh` is a no-op, because it has no discovery sources. A test that
means to exercise refresh wants `Registry.layer` over a fixture directory.

Constructing a descriptor by hand is the other half of this seam. Every field
of `Descriptor.FlowDescriptor` is required, which is deliberate: a fixture that
omitted `effects` would be testing against authority no real scan produces.

## Scanning a fixture directory

`Discovery.layer` over a fixture tree is the closest thing to production, and
it is what this package's own suites use. Point a source at the fixtures and
provide a real platform:

```ts
import * as Discovery from "@smthrs/registry/Discovery"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("./fixtures/project/flows", import.meta.url))
const source = { source: "project", root, naming: "path" } as const

const scan = Effect.gen(function*() {
  const discovery = yield* Discovery.Discovery
  return yield* discovery.scan(source)
}).pipe(Effect.provide(Discovery.layer), Effect.provide(platform))
```

Assert on the warnings as well as the entries. A scan that dropped an entry
reports why, so a fixture that stops being discovered fails a warning
assertion before it fails a behavior one.

`Discovery.make(fs, path)` builds the service from any `FileSystem` and `Path`
pair, so a test with an in-memory filesystem needs no Node bindings. Discovery
measures the bytes it actually reads rather than trusting `stat`, which is
exactly the case an in-memory or remote filesystem exercises.

## Testing the executable bridge

`Executable.Delegate` is structural: `_tag`, `call`, and `execute`. A
`Flow.make` value whose payload is `Executable.Invocation` satisfies it, and so
does a hand-written double that records what it received.

`Options.load` is the seam that keeps a module test off the filesystem. It
replaces the default dynamic `import`, so a test can supply a module object
directly, including one no file could contain:

```ts
const options: Executable.Options = {
  delegates: [Echo],
  load: () => Effect.succeed({ default: undefined })
}
```

Leave `load` absent whenever the real loader is what is under test. This
package's own suite does, so the `file:` specifier conversion is exercised by
every module fixture rather than by one test of the conversion.

`Executable.catalog` reports refusals instead of raising them, which is what
makes a mixed fixture directory a single assertion: the runnable entries in
`executables`, and every reason in `refused` with its code.
