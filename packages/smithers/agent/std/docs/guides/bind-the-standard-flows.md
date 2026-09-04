---
title: "Bind the standard flows into a host"
description: "Compose the platform and service layers the handlers require, offer the declarations to a model, and use the read-only projection for a restricted seat."
sidebar:
  order: 1
---

A host does two things with this package: it offers declarations to a model, and
it runs the matching handlers when a call arrives. This guide covers the
composition both halves need.

## Compose the host layer

Start with a platform layer, then add one layer per service a flow needs:

```ts
import { NodeServices } from "@effect/platform-node"
import * as Container from "@smthrs/std/Container"
import * as NativeSearch from "@smthrs/std/NativeSearch"
import * as TestRunner from "@smthrs/std/TestRunner"
import * as Layer from "effect/Layer"

/** FileSystem, Path, and ChildProcessSpawner. */
const platform = NodeServices.layer

const host = Layer.mergeAll(
  platform,
  // grep and glob, through the rg executable.
  NativeSearch.layer.pipe(Layer.provide(platform)),
  // bash and test, when a call names a container.
  Container.layerCommand({ program: "docker" }),
  // test: how this repository runs its suite.
  TestRunner.layer({ command: "pnpm vitest run", cwd: "/workspace" })
)
```

Swap `NativeSearch.layer` for `PortableSearch.layer` to search in process with
no external binary. Both satisfy the same `Search` service, and nothing above
the layer changes.

A host that cannot serve a service binds its refusal layer instead of leaving it
out, so the failure names the missing service rather than a missing context:

```ts
import * as Checkpoints from "@smthrs/std/Checkpoints"
import * as LanguageServer from "@smthrs/std/LanguageServer"
import * as WebSearch from "@smthrs/std/WebSearch"

const unavailable = Layer.mergeAll(
  WebSearch.layerNoop, // websearch fails with provider_unavailable
  LanguageServer.layerNoop, // lsp fails with unsupported
  Checkpoints.layerNoop // pinning fails with provider_unavailable
)
```

## Run one handler

A handler is an ordinary Effect. Provide the composed host and run it:

```ts
import * as Grep from "@smthrs/std/Grep"
import * as Effect from "effect/Effect"

const hits = Effect.provide(
  Grep.run({ pattern: "TODO", root: "/workspace", globs: ["*.ts"] }),
  host
)
```

## Offer the declarations

`Manifest.flows` is the declaration registry, keyed by the same names a model
calls. Offering all 17 is one expression:

```ts
import * as Manifest from "@smthrs/std/Manifest"

const offered = Manifest.names.map((name) => Manifest.flows[name])
```

For a seat that must not change anything, use the read-only projection instead
of filtering by hand:

```ts
const readOnly = Manifest.readOnly.map((name) => Manifest.flows[name])
```

`Manifest.readOnly` is `read`, `ls`, `glob`, `grep`, `fetch`, `explore`,
`webfetch`, and `lsp`. `websearch` is not in it: its provider contract requires
`net:post` authority, which is mutating under the kernel capability taxonomy.

## Narrow the envelope for one call

When a call arrives, narrow its declared envelope to what that input actually
touches before scheduling it. `Manifest.effectsFor` reaches the narrowing by
name:

```ts
const narrowed = Manifest.effectsFor["read"]({ path: "/workspace/notes.md" })
// reads: ["/workspace/notes.md"], instead of the declared ["/**"]
```

Without this, two reads of two different files serialize against each other. See
[Effects and capabilities](../concepts/effects-and-capabilities.md).

## The production path

[`@smthrs/agent`](/api/agent) already does all of this. Its `StandardFlows`
module pairs each declaration with its handler through
[`@smthrs/harness`](/api/harness)'s `FlowBinding` contract, and groups them by
the slice of host services they need: `filesystem` binds `read`, `write`,
`edit`, `apply_patch`, `ls`, `glob`, and `grep`; `shell` binds `bash`; `tests`
binds `test`. If you are building an agent rather than a tool host, start there:
[Give a run capabilities](/pkg/agent/guides/capabilities).
