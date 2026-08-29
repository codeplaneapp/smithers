# `@smthrs/artifacts`

The content-addressed artifact store: bytes addressed by their own SHA-256
digest.

This is the second half of the cache. `@smthrs/step-cache` maps a step key to a
recorded result; a recorded result references its large outputs **by digest**
rather than inlining them, and those bytes live here. `docs/specs/Specs/Object
Model.md` names both halves as the `Cache` service's job; `docs/specs/Specs/Input.md`
is where "large values enter by digest" comes from.

The package name says what it stores, per the naming rule in
`docs/specs/Concepts/Journal Split.md`. It depends on `effect` and
`@smthrs/crypto` and nothing else, owns no SQL, and bundles for the browser.

## Public API

| Export                                             | Meaning                                                                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ArtifactStore.ArtifactStore`                      | The service tag. Identity `@smthrs/artifacts/ArtifactStore`                                                                             |
| `ArtifactStore.Service`                            | `put(bytes)`, `get(digest)`, `has(digest)`, `findMissing(digests)`                                                                      |
| `ArtifactStore.ArtifactMissing`                    | The typed miss — the answer a read-through composition acts on                                                                          |
| `ArtifactStore.ArtifactCorruption`                 | Bytes at an address no longer hash to it                                                                                                |
| `ArtifactStore.ArtifactStoreError`                 | Host, transport, or invalid-address failures; retryable                                                                                 |
| `ArtifactStore.makeFileSystem`, `.layerFileSystem` | Over Effect's `FileSystem` tag                                                                                                          |
| `ArtifactStore.makeMemory`, `.layerMemory`         | For tests and browser hosts with no durable filesystem                                                                                  |
| `ArtifactStore.makeNoop`, `.layerNoop`             | Everything unavailable, with per-method overrides                                                                                       |
| `ArtifactSweep.ArtifactSweep`                      | The sweep tag. Identity `@smthrs/artifacts/ArtifactSweep`                                                                               |
| `ArtifactSweep.Service`                            | `inventory`, `remove(digest, { ifUnmodifiedSinceMs })` — host-local enumeration and mtime-fenced deletion for the engine's `ArtifactGc` |
| `ArtifactSweep.makeFileSystem`, `.layerFileSystem` | Over the same objects directory the store publishes into                                                                                |
| `ArtifactSweep.makeNoop`, `.layerNoop`             | Everything unavailable, with per-method overrides                                                                                       |
| `RemoteArtifacts.make`, `.layer`                   | The shared tier over Effect's `HttpClient` tag                                                                                          |
| `CombinedArtifacts.make`, `.layer`                 | Local-first, remote-second, with local write-back                                                                                       |

```ts
import { ArtifactStore, CombinedArtifacts, RemoteArtifacts } from "@smthrs/artifacts"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"

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
  journaled, and not part of any recorded result
  (`docs/specs/Specs/Input.md`, "secrets are never input").

## Prior art

The contract's ergonomics follow Effect's own `KeyValueStore`
(`effect/unstable/persistence/KeyValueStore`) — one small set of total
operations over one address space, so memory, filesystem, and network
implementations are the same shape.

Everything else is Bazel's remote-cache layer
(`reference/bazel/src/main/java/com/google/devtools/build/lib/remote/`):

| Taken from                         | What                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `common/MissingDigestsFinder.java` | `findMissing` as one batched probe whose result is guaranteed to be a subset of its input                                         |
| `disk/DiskCacheClient.java`        | The two-hex-prefix fanout layout, "to bypass possible folder file count limits", and the fsync of the temp file before the rename |
| `http/HttpCacheClient.java`        | The wire protocol: CAS blobs under `/cas/base16-key`, `PUT` to upload, `GET` to download                                          |
| `CombinedCache.java` (230-303)     | Local first, remote second, write back what the remote returned                                                                   |

**Deviations.** Bazel's HTTP client has no `findMissingDigests` at all — it
answers "everything is missing" and re-uploads — so `POST /cas/findMissing` and
`HEAD /cas/{digest}` are ours. Bazel's disk `findMissingDigests` likewise
returns its whole input; ours probes for real, because our combined store uses
the local answer to decide what to fetch. And Bazel threads a per-request
read/write cache policy through every call; we have no such object, so composing
only the local tier is how a caller opts out.

## Not here

Reclaiming published artifacts is an explicit verb per
`docs/specs/Concepts/Reconciliation.md`, never a side effect of a store
operation. The `.tmp-*` sweep in `layerFileSystem` reclaims crash orphans only;
`ArtifactSweep` is the deletion surface, and the mark phase that decides what
is live belongs to `@smthrs/engine-store`'s `ArtifactGc`
(`docs/pages/artifact-gc.mdx`). Two concerns are ticketed rather than silently
omitted (`docs/specs/Concepts/Tickets Not Exceptions.md`):

- `.smithers/tickets/cas-chunked-transfer.md` — chunked and resumable transfer.
- `.smithers/tickets/remote-cache-download-policy.md` — a `RemoteOutputChecker` analogue.
