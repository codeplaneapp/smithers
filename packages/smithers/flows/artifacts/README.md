# `@smthrs/artifacts`

**Documentation:** https://artifacts.smithers.sh

The content-addressed artifact store: bytes addressed by their own SHA-256
digest.

This is the byte half of the cache. [`@smthrs/step-cache`](https://smithers.sh/api/step-cache)
maps a step key to a recorded result; large outputs are referenced **by digest**
and live here. The package depends on `effect` and `@smthrs/crypto`, owns no
SQL, and bundles for the browser.

## Public API

| Export                                                                     | Meaning                                                                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ArtifactStore.ArtifactStore`                                              | The service tag. Identity `@smthrs/artifacts/ArtifactStore`                                                                             |
| `ArtifactStore.Service`                                                    | `put(bytes)`, `get(digest)`, `has(digest)`, `findMissing(digests)`                                                                      |
| `ArtifactStore.ArtifactMissing`                                            | The typed miss — the answer a read-through composition acts on                                                                          |
| `ArtifactStore.ArtifactCorruption`                                         | Bytes at an address no longer hash to it                                                                                                |
| `ArtifactStore.ArtifactStoreError`                                         | Typed digest, configuration, host, crypto, and transport failures                                                                       |
| `ArtifactStore.Digest`                                                     | Schema and branded type for exactly 64 lowercase hexadecimal SHA-256 characters                                                         |
| `ArtifactStore.ArtifactStoreErrorCode`                                     | Schema and type for the stable store error codes                                                                                        |
| `ArtifactStore.validateDigest`                                             | Validates an untrusted string before a tier logs it or uses it in a path or URL                                                         |
| `ArtifactStore.measureBytes`                                               | Measures an immutable byte snapshot with the injected `Crypto` service                                                                  |
| `ArtifactStore.snapshotBytes`                                              | Copies caller-owned bytes when the returned Effect begins                                                                               |
| `ArtifactStore.makeFileSystem`, `.layerFileSystem`                         | Over Effect's `FileSystem` tag                                                                                                          |
| `ArtifactStore.FileSystemOptions.coordination`                             | `process` keeps in-process serialization but gives up cross-process writer/sweeper exclusion; the paired sweep also skips backup leases |
| `ArtifactStore.makeMemory`, `.layerMemory`                                 | For tests and browser hosts with no durable filesystem                                                                                  |
| `ArtifactStore.makeNoop`, `.layerNoop`                                     | Everything unavailable, with per-method overrides                                                                                       |
| `ArtifactBackupLease.withLease`, `.unlessActive`                           | Cross-process exclusion between a filesystem backup and sweep deletion                                                                  |
| `ArtifactSweep.ArtifactSweep`                                              | The sweep tag. Identity `@smthrs/artifacts/ArtifactSweep`                                                                               |
| `ArtifactSweep.Service`                                                    | `inventory`, `remove(digest, { ifUnmodifiedSinceMs })` — host-local enumeration and mtime-fenced deletion for the engine's `ArtifactGc` |
| `ArtifactSweep.makeFileSystem`, `.layerFileSystem`                         | Over the same objects directory the store publishes into                                                                                |
| `ArtifactSweep.makeNoop`, `.layerNoop`                                     | Everything unavailable, with per-method overrides                                                                                       |
| `RemoteArtifacts.make`, `.layer`                                           | The shared tier over Effect's `HttpClient` tag, with `chunkBytes` for resumable `Content-Range` uploads                                 |
| `RemoteArtifacts.Service`                                                  | An `ArtifactStore.Service` that also declares its `downloadPolicy`                                                                      |
| `RemoteArtifacts.DownloadPolicy`, `.downloadPolicies`, `.downloadPolicyOf` | `all` \| `toplevel` \| `minimal`, the list of them, and the reader that answers `undefined` for a store declaring none                  |
| `CombinedArtifacts.make`, `.layer`                                         | Local-first, remote-second, with local write-back under `all` and `toplevel`; `minimal` writes back only to repair a corrupt address    |
| `ArtifactStoreMetrics.puts`                                                | `flows_artifact_puts`, updated by successful filesystem and memory puts                                                                 |
| `ArtifactStoreMetrics.gets`                                                | `flows_artifact_gets`, updated by successful filesystem and memory gets                                                                 |

## Resource and failure contract

| Boundary                                  | Default                 | Guarantee                                                                    |
| ----------------------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| Filesystem directory                      | `.flows/objects`        | Two-hex fanout, atomic publication, digest verification, required fsync      |
| Cross-process coordination                | `required`              | Writers and sweepers share per-digest lock files; stale owners are recovered |
| Remote request, upload, download deadline | 60 seconds each         | No remote exchange can wait forever                                          |
| Maximum downloaded blob                   | 256 MiB                 | The body is rejected before or while buffering past the limit                |
| `findMissing` batch / response            | 1,000 digests / 256 KiB | Inputs are validated and deduplicated in first-seen order                    |
| Combined upload deadline                  | 60 seconds              | Local publication remains authoritative when the opportunistic upload fails  |

`invalid_configuration` and `invalid_digest` are permanent caller failures.
`ArtifactMissing` is an ordinary miss, and `ArtifactCorruption` is an integrity
failure. `digest_failed`, `unavailable`, and `transport_failed` describe host
or transport failures whose retryability depends on the host and operation.

Every `put` snapshots its bytes when the Effect begins. Stores never retain a
caller-owned buffer, and every successful `get` returns a new byte array.

```ts
import { ArtifactStore, CombinedArtifacts, RemoteArtifacts } from "@smthrs/artifacts"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"

declare const token: string

const layer = CombinedArtifacts.layer({
  local: Effect.map(FileSystem.FileSystem, (fs) => ArtifactStore.makeFileSystem(fs)),
  remote: RemoteArtifacts.make({
    endpoint: "https://cache.example.com",
    headers: { authorization: `Bearer ${token}` }
  })
})
```

## The invariants

- **Every read is digest-verified.** A truncated blob left by a crashing writer,
  a corrupted disk, or a mis-serving shared tier is refused with
  `ArtifactCorruption`, never handed back as the recorded artifact. The memory
  store is the one exception, and deliberately: its address space is a private
  `Map` keyed by the digest it measured, so there is no window in which the
  address and the content can disagree.
- **Publication is atomic.** Bytes land at a temp path in the destination
  directory, are fsynced, and are renamed into place. Temp names fold a random
  per-instance token, so two processes publishing the same digest into one
  workspace never share a scratch path.
- **An existing blob is verified on every `put`.** The objects directory is
  workspace-shared, so a remembered proof could outlive the bytes it proved; a
  mismatch or failing read falls through to the atomic rewrite and heals the
  address.
- **The endpoint and its credentials are a capability, never an input.** They
  arrive as layer construction options: they are not hashed into a step key, not
  journaled, and not part of any recorded result. `RemoteArtifacts` refuses a
  non-HTTPS endpoint and any endpoint carrying credentials, a query, or a
  fragment at construction as `invalid_configuration`. The sanitized message
  names only the violated rule, so the failure text never echoes the endpoint.

## Prior art

The contract's ergonomics follow Effect's own `KeyValueStore`
(`effect/unstable/persistence/KeyValueStore`) — one small set of total
operations over one address space, so memory, filesystem, and network
implementations are the same shape.

Everything else follows Bazel's remote-cache Java classes:

| Taken from                                                                                                                                                                | What                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [`common/MissingDigestsFinder.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/remote/common/MissingDigestsFinder.java) | `findMissing` as one batched probe whose result is guaranteed to be a subset of its input                                         |
| [`disk/DiskCacheClient.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/remote/disk/DiskCacheClient.java)               | The two-hex-prefix fanout layout, "to bypass possible folder file count limits", and the fsync of the temp file before the rename |
| [`http/HttpCacheClient.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/remote/http/HttpCacheClient.java)               | The wire protocol: CAS blobs under `/cas/base16-key`, `PUT` to upload, `GET` to download                                          |
| [`CombinedCache.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/remote/CombinedCache.java) (230-303)                   | Local first, remote second, write back what the remote returned                                                                   |

**Deviations.** Bazel's HTTP client has no `findMissingDigests` at all — it
answers "everything is missing" and re-uploads — so `POST /cas/findMissing` and
`HEAD /cas/{digest}` are ours. Bazel's disk `findMissingDigests` likewise
returns its whole input; ours probes for real, because our combined store uses
the local answer to decide what to fetch. And Bazel threads a per-request
read/write cache policy through every call; we have no such per-request object.
The analogous dial is `RemoteArtifacts.Options.downloadPolicy`, declared once on
the shared tier, and composing only the local tier is how a caller opts out of a
shared tier entirely.

## Not here

Reclaiming published artifacts is an explicit operation, never a side effect of
a store call. The `.tmp-*` sweep in `layerFileSystem` reclaims crash orphans
only; `ArtifactSweep` is the deletion surface, and the mark phase that decides
what is live belongs to `@smthrs/engine-store`'s
[`ArtifactGc`](https://smithers.sh/artifact-gc).

Chunked and resumable transfer is `RemoteArtifacts.Options.chunkBytes`, and the
`RemoteOutputChecker` analogue is `RemoteArtifacts.Options.downloadPolicy`
(`all` | `toplevel` | `minimal`), honored by `CombinedArtifacts.get` and by
[`@smthrs/engine-store`](https://smithers.sh/api/engine-store)'s
`ArtifactSync.hydrate`.
