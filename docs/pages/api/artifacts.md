---
description: "The content-addressed artifact store: bytes addressed by their own SHA-256 digest."
---

# @smthrs/artifacts

The content-addressed artifact store: bytes addressed by their own SHA-256 digest. It is the other half of the cache: [`@smthrs/step-cache`](/api/step-cache) maps a step key to a recorded result, and a recorded result references its large outputs by digest. It depends on `effect` and `@smthrs/crypto` and nothing else, so the package root bundles for the browser.

```ts
import { ArtifactStore, CombinedArtifacts, RemoteArtifacts } from "@smthrs/artifacts"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"

const layer = CombinedArtifacts.layer({
  local: Effect.map(FileSystem.FileSystem, (fs) => ArtifactStore.makeFileSystem(fs)),
  remote: RemoteArtifacts.make({ endpoint: "https://cache.example.com" })
})
```

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/artifacts` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/artifacts/src/index.ts) | any |

## ArtifactStore

[src/ArtifactStore.ts](https://github.com/smithersai/flows/blob/main/packages/artifacts/src/ArtifactStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `ArtifactStore` | service tag | `put`, `get`, `has`, `findMissing` |
| `Digest` | schema + type | 64 lowercase hex characters, branded by `@smthrs/crypto` |
| `ArtifactMissing` | error | the typed miss a read-through composition acts on |
| `ArtifactCorruption` | error | stored bytes no longer hash to their address |
| `ArtifactStoreError`, `ArtifactStoreErrorCode` | class + codes | `invalid_digest`, `unavailable`, `transport_failed` |
| `FileSystemOptions` | interface | `directory`, default `.flows/objects` |
| `validateDigest` | predicate | refuses an address that cannot be a path segment, before any tier interpolates it |
| `makeFileSystem`, `makeMemory`, `makeNoop` | constructors | |
| `layerFileSystem`, `layerMemory`, `layerNoop` | layers | |

A digest reaches a read straight out of a durable row, so every implementation validates it before interpolating it into a location: a path under the objects directory, a `/cas/{digest}` URL. The 64-hex *shape* is deliberately not enforced, because refusing to look up an unfamiliar address would reclassify an ordinary miss as a caller error. The digest verification on read is the check that actually protects the caller.

## ArtifactSweep

[src/ArtifactSweep.ts](https://github.com/smithersai/flows/blob/main/packages/artifacts/src/ArtifactSweep.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `ArtifactSweep` | service tag | host-local blob enumeration and fenced deletion |
| `Service` | interface | `inventory`, `remove(digest, { ifUnmodifiedSinceMs })` |
| `BlobStat` | interface | `digest`, `modifiedAtMs`, `sizeBytes` |
| `RemoveOptions` | interface | the mtime fence a deletion rides in |
| `makeFileSystem`, `makeNoop` | constructors | |
| `layerFileSystem`, `layerNoop` | layers | |

The sweep half of [Artifact GC](/artifact-gc), deliberately not part of `ArtifactStore.Service`: a remote tier can neither enumerate its address space nor accept a delete, so only the host-local filesystem store implements it. `remove`'s fence refuses a blob freshened past the bound, which is how a concurrent `put` re-referencing old bytes survives a sweep.

## ArtifactStoreMetrics

[src/ArtifactStoreMetrics.ts](https://github.com/smithersai/flows/blob/main/packages/artifacts/src/ArtifactStoreMetrics.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `puts` | counter | `flows_artifact_puts`; successful puts, deduplicated ones included |
| `gets` | counter | `flows_artifact_gets`; successful digest-verified gets. Typed misses are error evidence, not throughput |

The local implementations update them, so a `CombinedArtifacts` stack counts once per tier it actually touched.

## RemoteArtifacts

[src/RemoteArtifacts.ts](https://github.com/smithersai/flows/blob/main/packages/artifacts/src/RemoteArtifacts.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Options` | interface | `endpoint`, `headers`; a capability, never a step-key input |
| `make`, `layer` | constructor + layer | `GET`/`PUT`/`HEAD /cas/{digest}`, `POST /cas/findMissing` over Effect's `HttpClient` |

## CombinedArtifacts

[src/CombinedArtifacts.ts](https://github.com/smithersai/flows/blob/main/packages/artifacts/src/CombinedArtifacts.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Options` | interface | the `local` and `remote` tiers |
| `make`, `layer` | constructor + layer | local-first read-through with local write-back; in-flight uploads deduplicate per digest |

`put` records locally and its local digest is the answer. The upload to the shared tier is opportunistic and a refusal is dropped, because failing there would fail whatever produced the bytes over an unreachable *cache*.

:::note
What gates a shared cache entry is the publication protocol's `findMissing`, upload, confirm sequence, not this upload.
:::
