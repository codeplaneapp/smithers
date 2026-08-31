---
description: "The content-addressed artifact store: bytes addressed by their own SHA-256 digest."
---

# @smthrs/artifacts

The content-addressed artifact store: bytes addressed by their own SHA-256 digest. It is the other half of the cache: [`@smthrs/step-cache`](/api/step-cache) maps a step key to a recorded result, and a recorded result references its large outputs by digest. It depends on `effect` and [`@smthrs/crypto`](/api/crypto) and nothing else, so the package root bundles for the browser.

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
| `@smthrs/artifacts` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/artifacts/src/index.ts) | any |

## ArtifactStore

[src/ArtifactStore.ts](https://github.com/smithersai/smithers/blob/main/packages/artifacts/src/ArtifactStore.ts)

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

[src/ArtifactSweep.ts](https://github.com/smithersai/smithers/blob/main/packages/artifacts/src/ArtifactSweep.ts)

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

[src/ArtifactStoreMetrics.ts](https://github.com/smithersai/smithers/blob/main/packages/artifacts/src/ArtifactStoreMetrics.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `puts` | counter | `flows_artifact_puts`; successful puts, deduplicated ones included |
| `gets` | counter | `flows_artifact_gets`; successful digest-verified gets. Typed misses are error evidence, not throughput |

The local implementations update them, so a `CombinedArtifacts` stack counts once per tier it actually touched.

## RemoteArtifacts

[src/RemoteArtifacts.ts](https://github.com/smithersai/smithers/blob/main/packages/artifacts/src/RemoteArtifacts.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Options` | interface | `endpoint`, `headers`; a capability, never a step-key input |
| `make`, `layer` | constructor + layer | `GET`/`PUT`/`HEAD /cas/{digest}`, `POST /cas/findMissing` over Effect's `HttpClient` |

## CombinedArtifacts

[src/CombinedArtifacts.ts](https://github.com/smithersai/smithers/blob/main/packages/artifacts/src/CombinedArtifacts.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Options` | interface | the `local` and `remote` tiers |
| `make`, `layer` | constructor + layer | local-first read-through with local write-back; in-flight uploads deduplicate per digest |

`put` records locally and its local digest is the answer. The upload to the shared tier is opportunistic and a refusal is dropped, because failing there would fail whatever produced the bytes over an unreachable *cache*.

:::note
What gates a shared cache entry is the publication protocol's `findMissing`, upload, confirm sequence, not this upload.
:::

## API reference

This page is the public API reference for the **content-addressed artifact
store**: bytes addressed by their own SHA-256 digest.

It is the other half of the cache. [`@smthrs/step-cache`](/api/step-cache) maps a
step key to a recorded result; a recorded result references its large outputs by
digest rather than inlining them, and those bytes live here. See
`docs/specs/Specs/Object Model.md` (the `Cache` service owns "a
content-addressed store for artifacts"), `docs/specs/Specs/Input.md` ("large
values enter by digest"), and `docs/specs/Concepts/Remote Cache.md`.

The package depends on `effect` and `@smthrs/crypto` and nothing else, owns no
tables, and needs no migration.

### ArtifactStore

`ArtifactStore` exposes `put`, `get`, `has`, and `findMissing`. `put` measures
the bytes and returns their address; `get` verifies that the stored bytes still
hash to the address it was asked for; `findMissing` is one batched probe whose
result is guaranteed to be a deduplicated subset of its input.

Three error tags, deliberately distinct. `ArtifactMissing` is the typed miss , 
an ordinary, expected outcome that a second tier may satisfy. `ArtifactCorruption`
is an integrity violation: the bytes at an address no longer hash to it.
`ArtifactStoreError` is neither: a failing host, an unreachable tier, or an
address that is not usable as one, and stays retryable. Collapsing the three
into one code is exactly what makes a shared cache unsafe: a miss is fetchable,
corruption is not, and a host refusal says nothing at all.

Implementations: `makeFileSystem` / `layerFileSystem` over Effect's `FileSystem`
tag, `makeMemory` / `layerMemory` for tests and browser hosts, and
`makeNoop` / `layerNoop` per house style.

`layerFileSystem` publishes at `${directory}/${digest[0:2]}/${digest}` , 
Bazel's `DiskCacheClient` fanout, with a default directory of `.flows/objects`.
Bytes land at a temp path in that directory, are fsynced where the host has
writable file handles, and are renamed into place. Temp names fold a random
per-instance token so two processes publishing one digest into a shared
workspace never collide. An existing blob is digest-verified on every
`put`: the objects directory is workspace-shared, so a remembered proof could
outlive the bytes it proved, and a mismatch or failing read falls through to
the atomic rewrite, healing the address.

### RemoteArtifacts

The shared tier, spoken over HTTP: `GET`/`PUT`/`HEAD /cas/{digest}` and
`POST /cas/findMissing`. Transport is Effect's own `HttpClient` tag, which the
capability kernel already decorates with `net:get`/`net:post` checks, so a
remote artifact fetch is permission-checked like any other egress.

Every download is digest-verified before it is returned. The shared tier is the
least trusted store there is: it is written by machines this one has never
met, so a mis-serving or compromised cache can waste a round trip but can never
substitute content.

The endpoint and its headers are **layer construction options**: a capability,
never an input. They are not hashed into a step key, not journaled, and not part
of any recorded result.

#### Chunked uploads

`chunkBytes` turns an upload past that size into a sequence of `Content-Range`
`PUT`s. The transfer opens with `HEAD /cas/{digest}`, which ends it when the
tier already holds `{total}` bytes, then a `Content-Range: bytes */{total}`
probe carrying no body, which asks what prefix the tier holds, so a transfer
that died partway costs one round trip instead of the whole blob. From there:

| Answer | Meaning |
| --- | --- |
| `308` | Keep going. A `Range: bytes=0-{last}` header moves the offset to `last + 1`; only a prefix starting at zero is usable. |
| `2xx` on the chunk that completes the blob | The tier claims the whole blob. The claim is confirmed with `HEAD` before `put` returns. |
| `2xx` anywhere else | The tier is not reading `Content-Range`. The client sends the blob whole. |
| `411` or `416` | The tier does not accept ranged bodies. The client sends the blob whole. |
| anything else | A transport failure. The blob is not re-sent. |

The offset never moves backwards, so a tier reporting a shorter prefix than the
chunk just delivered cannot loop the transfer. `chunkBytes` is absent by
default: every upload is one whole-blob `PUT`, which is what Bazel's dumb-HTTP
client does and what a deployment already serving this protocol expects.

Turning the dial on against a server that never learned about it costs round
trips and never a digest published over bytes the server does not hold. A plain
WebDAV store answers the empty probe `201` and keeps its zero-byte body, so a
`2xx` is read as a refusal rather than a completion, and the whole-blob `PUT`
that follows overwrites whatever the sequence left behind. The closing `HEAD`
covers the rest: a tier that answers `2xx` to the completing chunk but stores
something shorter, or that reports no `Content-Length` at all, gets the blob
whole. `packages/artifacts/test/RemoteArtifactsServer.test.ts` runs each of
those servers for real over loopback and asserts the bytes it ends up holding.

#### The endpoint is HTTPS only

`RemoteArtifacts` refuses any endpoint that is not `https:`, along with one
carrying credentials, a query, or a fragment, before it sends a single header.
The endpoint options carry a bearer token, and a loopback exception would be a
credential leak waiting for a misconfiguration. A local development CAS
therefore needs TLS; `examples/src/35-remote-cache.ts` composes the action-cache
half over plain HTTP for that reason and says so.

### CombinedArtifacts

Local first, remote second, with local write-back. Bazel's `CombinedCache`
shape. A local miss *or* a local corruption falls through to the shared tier,
and the write-back hands the correct bytes to `local.put`, whose own
verification rewrites the mismatched blob: a read-through heals a corrupt local
address rather than failing on it forever. Concurrent uploads of one digest
deduplicate in flight.

A `put` records locally first and its local digest is the answer: the upload to
the shared tier is opportunistic, and a refusal is dropped rather than
propagated. Failing there would fail whatever produced the bytes: a step's
`settle`, say: because a *cache* was unreachable. Nothing depends on that
upload; what gates a shared cache entry is the publication protocol's
`findMissing` → upload → confirm, run before the entry is published, so a
dropped upload costs one re-upload and never correctness.

### Entry points

The root is written against Effect's `FileSystem` and `HttpClient` contracts and
bundles for the browser (`pnpm run browser`). See
[browser support](/architecture/browser-support).

### The download policy

`RemoteArtifacts.Options.downloadPolicy` is Bazel's `RemoteOutputChecker` dial
(`--remote_download_{all,toplevel,minimal}`). It is declared on the shared tier,
because the shared tier is the thing being conserved, and two seams honor it.

| Policy | `ArtifactSync.hydrate` prefetch | `CombinedArtifacts.get` on a local miss |
| --- | --- | --- |
| `all` (default) | Downloads every referenced blob into the local tier while admitting the replay. | Serves the local copy the prefetch wrote. |
| `toplevel` | Downloads nothing. One batched `findMissing` establishes that the tier can serve what is missing. | Downloads and writes back, so the second read is local. |
| `minimal` | Downloads nothing, same probe. | Downloads and serves without writing back: the local tier never grows. |

`toplevel` and `minimal` therefore materialize only what a reader actually
reads, which is what Bazel's `toplevel` means; they differ in whether the blob
stays. `packages/engine-store/test/RemoteCacheProtocol.test.ts` proves the
`minimal` half through the dispatch itself: a step whose evidence references an
artifact is recorded on one host, replayed on a host that has never seen the
bytes with zero GETs served at admission, and the bytes arrive on the first
read through `CombinedArtifacts`. Both are sound only when the store the replay reads through can reach the
shared tier, which means `CombinedArtifacts` over the same remote tier. A tier
that refuses the probe is indistinguishable from one holding nothing, so the
replay is refused and the step executes.

`CombinedArtifacts.Options.downloadPolicy` overrides the tier's declaration for
one composition. `RemoteArtifacts.downloadPolicyOf` reads the declaration off any
store and answers `undefined` for a store that declares none, which is every
local store.

### Not here

Reclaiming published artifacts is an explicit `ArtifactGc.gc()` operation in
`@smthrs/engine-store`, backed by the host-local `ArtifactSweep` service
in this package. It is never a side effect of a store operation. The
`.tmp-*` sweep reclaims crash orphans, and artifact GC removes unreferenced
blobs only after its mark and grace-period checks.

Chunked and resumable transfer is the `chunkBytes` dial above.

See `docs/specs/Concepts/Remote Cache.md` and the
[`@smthrs/engine-store` reference](/api/engine-store) for the publication ordering
that binds this store to the step cache.
