---
title: "@smthrs/artifacts"
description: "The content-addressed artifact store: bytes addressed by their own SHA-256 digest, with a filesystem tier, a shared HTTP tier, a local-first composition of the two, and a fenced sweep that reclaims them."
---

`@smthrs/artifacts` stores bytes under their own SHA-256 digest and hands them
back only when they still hash to that address.

It is the byte half of the Smithers cache. [`@smthrs/step-cache`](/api/step-cache)
maps a step key to a recorded result; a result too large to sit inline is
referenced by digest and its bytes live here. Nothing in this package knows
what a step is: the contract is `put`, `get`, `has`, and `findMissing` over one
address space, so the same four operations work over a directory on disk, a map
in a browser tab, or an HTTP cache shared by a fleet.

The package depends on `effect` and [`@smthrs/crypto`](/api/crypto), owns no SQL,
and bundles for the browser. Host access arrives through Effect's `FileSystem`
and `HttpClient` tags, both of which the capability kernel decorates in place,
so a filesystem write or a cache fetch is permission checked like any other
host access.

## Who uses this package

Engine and host authors compose an `ArtifactStore` so large step outputs spill
somewhere durable instead of into a database row. Build and CI operators
compose the shared tier so a second machine reads what the first one produced.
Backup and retention tooling uses `ArtifactSweep` and `ArtifactBackupLease` to
reclaim disk without deleting bytes something still references.

## Install

```bash
pnpm add @smthrs/artifacts@next
```

For the peer packages a runnable composition adds, see
[Installation](./installation.md).

## The smallest real example

Store bytes, get an address, read them back:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const program = Effect.gen(function*() {
  const store = yield* ArtifactStore.ArtifactStore
  const digest = yield* store.put(new TextEncoder().encode("dist/server.js"))
  return yield* store.get(digest)
})

const store = ArtifactStore.layerFileSystem().pipe(Layer.provide(NodeFileSystem.layer))

await Effect.runPromise(program.pipe(Effect.provide(store), Effect.provide(NodeCrypto.layer)))
```

`digest` is 64 lowercase hexadecimal characters, and it is the only name those
bytes will ever have. The [Quickstart](./quickstart.md) takes the same store
through dedupe, a miss, and a corrupted blob.

## The package at a glance

The root entry point exports each module as a namespace, and each is also
importable from `@smthrs/artifacts/<Module>`:

| Namespace              | What it is                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `ArtifactStore`        | The store contract, its typed errors, and the filesystem, memory, and no-op implementations.       |
| `RemoteArtifacts`      | The same contract spoken over HTTP to a shared cache, plus the download policy that tier declares. |
| `CombinedArtifacts`    | Local first, shared second, with write-back: the production composition.                           |
| `ArtifactSweep`        | Host-local enumeration and mtime-fenced deletion, the mechanics half of garbage collection.        |
| `ArtifactBackupLease`  | Cross-process exclusion between a running backup and a sweep deletion.                             |
| `ArtifactStoreMetrics` | The two counters the local implementations update.                                                 |

Every export, with its signature and failure modes, is on the
[API reference](./api.md).

## What the store guarantees

- **Every read is digest verified.** A truncated blob left by a crashing
  writer, or a shared tier serving the wrong bytes, fails with
  `ArtifactCorruption` rather than being returned as the recorded artifact.
- **Publication is atomic.** Bytes land at a unique temp path in the
  destination directory, are fsynced, and are renamed into place, so no reader
  ever observes a partial file at a content address.
- **An existing blob is verified on every put.** The objects directory is
  shared by the whole workspace, so a remembered proof could outlive the bytes
  it proved. A mismatch falls through to the atomic rewrite and heals the
  address.
- **The endpoint and its credentials are a capability, never an input.** They
  arrive as construction options: not hashed into a step key, not journaled,
  and not part of any recorded result.

[Content addressing](./concepts/content-addressing.md) explains why each of
those holds.

## Where to go next

- [Installation](./installation.md): the peer packages, the services a
  composition must provide, and the import forms.
- [Quickstart](./quickstart.md): publish, deduplicate, and repair a blob on a
  real directory.
- Concepts: [content addressing](./concepts/content-addressing.md),
  [the three tiers](./concepts/tiers.md), and
  [coordination between processes](./concepts/coordination.md).
- Guides: [share artifacts across machines](./guides/share-artifacts-across-machines.md),
  [serve the artifact protocol](./guides/serve-the-artifact-protocol.md),
  [reclaim disk space](./guides/reclaim-disk-space.md),
  [fence a backup against the sweep](./guides/fence-a-backup.md), and
  [test against an artifact store](./guides/test-against-an-artifact-store.md).
- [Troubleshooting](./troubleshooting.md): every typed failure, what causes it,
  and what to change.
