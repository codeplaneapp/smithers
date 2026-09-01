Addresses are the SHA-256 digests [`@smthrs/crypto`](/api/crypto) computes
through the injected `Crypto` service, which with `effect` is the whole
dependency list.

## Store contract

`ArtifactStore.Service` provides `put`, `get`, `has`, and `findMissing`. `put`
measures the bytes and returns their address. `get` verifies that stored bytes
still hash to the requested address before returning them. `findMissing`
validates and deduplicates its input and returns a first-seen-order subset of
that input.

`ArtifactStore.Digest` is both the schema and branded type for exactly 64
lowercase hexadecimal SHA-256 characters. Durable rows remain untrusted input,
so read operations accept strings and call `ArtifactStore.validateDigest`
before logging a digest or interpolating it into a path or URL. A valid address
with no bytes is `ArtifactMissing`; a malformed address is an
`ArtifactStoreError` with code `invalid_digest`.

Use `ArtifactStore.measureBytes` to compute a branded address with the injected
`Crypto` service. Use `ArtifactStore.snapshotBytes` to copy caller-owned bytes
when an Effect begins. The supplied stores snapshot every `put`, never retain a
caller's buffer, and return a fresh array from every successful `get`.

`ArtifactStoreErrorCode` defines the stable store codes. `invalid_configuration`
and `invalid_digest` are permanent caller failures. `digest_failed`,
`unavailable`, and `transport_failed` describe crypto, host, or transport
failures whose retryability depends on the operation and cause.
`ArtifactMissing` remains an ordinary miss that another tier may satisfy, while
`ArtifactCorruption` reports bytes that no longer hash to their recorded
address.

## Filesystem and memory stores

`ArtifactStore.makeFileSystem` publishes at
`${directory}/${digest.slice(0, 2)}/${digest}`. The directory defaults to
`ArtifactStore.defaultDirectory`, `.flows/objects`. Bytes land at a unique temp
path in the destination directory, are synced when required, and are renamed
into place. Every deduplicated `put` verifies the existing blob and rewrites an
unreadable or mismatched address atomically.

`FileSystemOptions.durability` defaults to `required`, which syncs the blob and
its fanout directory. `best-effort` is the explicit choice for a host that
cannot open handles for syncing.

`FileSystemOptions.coordination` also defaults to `required`. It combines an
in-process semaphore with heartbeat-backed lock files shared by all cooperating
processes. `process` keeps only the in-process semaphore. It gives up
cross-process exclusion between writers and sweep deletion. A sweep using
`process` also skips the backup lease. Build a store and its sweep with the
same directory and coordination mode; no runtime check can detect a mismatch.

`ArtifactStore.makeMemory` copies both boundaries around a private map. It does
not rehash a read because no caller-owned reference aliases stored bytes.
`makeNoop` supplies typed `unavailable` failures and accepts per-method
overrides.

## Sweep and backup exclusion

`ArtifactSweep` is the host-local deletion surface used by
[Artifact GC](/artifact-gc). `inventory` returns `BlobStat` values only for
canonical fanout files whose modification time is measurable. It skips temp
files, lock files, foreign paths, and entries that disappear during the scan.

`remove` accepts `RemoveOptions.ifUnmodifiedSinceMs` as part of the deletion
itself. A blob freshened after the collector computed its live set survives.
The method returns `false` when the blob is already gone, fails the age fence,
or is protected by a live backup lease. `SweepOptions` contains only
`directory` and `coordination`; durability is not a sweep concern.

`ArtifactBackupLease.withLease` holds a heartbeat-backed marker while a
filesystem backup freezes its database and copies referenced blobs. New blobs
may still be published during the backup. `ArtifactBackupLease.unlessActive`
checks the marker and runs one sweep deletion under the same workspace-global
gate. It returns `None` when a live backup deliberately fences the deletion.
This cross-process exclusion prevents a sweep from deleting a blob already
referenced by the frozen database. A crashed lease becomes reclaimable after
its heartbeat is stale.

## RemoteArtifacts

The shared tier uses Effect's `HttpClient` for `GET`, `PUT`, and `HEAD` at
`/cas/{digest}` and `POST` at `/cas/findMissing`. Every download is bounded and
digest-verified before it is returned.

The endpoint and headers are construction options, not step inputs. They are
not hashed into a step key, journaled, or returned in a recorded result.
Construction refuses a non-HTTPS endpoint and an endpoint containing
credentials, a query, or a fragment with `invalid_configuration`. The
sanitized failure message names only the violated rule and never echoes the
endpoint.

The three remote deadlines have separate purposes and default to 60 seconds:

| Option                                    | Scope                                                     |
| ----------------------------------------- | --------------------------------------------------------- |
| `RemoteArtifacts.Options.downloadTimeout` | One download, including the complete response body.       |
| `RemoteArtifacts.Options.uploadTimeout`   | One upload, including all resume probes and chunks.       |
| `RemoteArtifacts.Options.requestTimeout`  | One `HEAD` probe or one `findMissing` batch and response. |

`RemoteArtifacts.Options.maxDownloadBytes` defaults to 256 MiB. The client
rejects an excessive `Content-Length` before reading the body and stops an
incremental read as soon as it crosses the bound.
`RemoteArtifacts.Options.maxFindMissingResponseBytes` defaults to 256 KiB and
may only lower that protocol bound. `findMissing` validates input before
sending requests, sends at most 1,000 digests per batch, and filters the server
response back to requested digests.

### Chunked uploads

`RemoteArtifacts.Options.chunkBytes` sends a larger blob as `Content-Range`
requests. The client first uses `HEAD` to detect a complete blob, then sends
an empty `Content-Range: bytes */{total}` probe to discover a retained prefix.

| Response                      | Client action                                               |
| ----------------------------- | ----------------------------------------------------------- |
| `308`                         | Continue after the reported `Range: bytes=0-{last}` prefix. |
| `2xx` on the completing chunk | Confirm the complete length with `HEAD`.                    |
| `2xx` before completion       | Treat the server as range-unaware and send the whole blob.  |
| `411` or `416`                | Send the whole blob.                                        |
| Any other status              | Fail the upload as a transport error.                       |

The offset never moves backward. If a server ignores ranges, omits a confirming
length, or stores a partial body, the whole-blob `PUT` overwrites the partial
result. `RemoteArtifacts.Options.chunkBytes` is absent by default.

## CombinedArtifacts

`CombinedArtifacts` reads the local tier first and falls back to the remote
tier only for `ArtifactMissing` or `ArtifactCorruption`. A local host refusal
does not silently fall through. A corrupt local address is repaired from the
remote bytes under every download policy.

`put` publishes locally first and returns the local digest. The remote upload
is opportunistic, deduplicated in flight by digest, and bounded by
`CombinedArtifacts.Options.uploadTimeout`, which defaults to 60 seconds. A
remote refusal or timeout does not fail the operation that produced the bytes.
The later shared-cache publication protocol uses `findMissing`, upload, and
confirmation before it publishes a cache entry, so an abandoned opportunistic
upload costs another transfer rather than correctness.

The remote tier declares its materialization policy, and
`CombinedArtifacts.Options.downloadPolicy` may override it for one
composition:

| Policy     | Read-through behavior                                              |
| ---------- | ------------------------------------------------------------------ |
| `all`      | Write a remotely fetched blob into the local tier.                 |
| `toplevel` | Write a remotely fetched blob into the local tier when first read. |
| `minimal`  | Serve a remote hit without growing the local tier.                 |

`@smthrs/engine-store` also reads the policy when deciding whether
`ArtifactSync.hydrate` prefetches referenced blobs. `minimal` still writes back
after local corruption because replacing an address already claimed by the
local tier is repair, not growth.

## Metrics

`ArtifactStoreMetrics.puts` is `flows_artifact_puts`, and
`ArtifactStoreMetrics.gets` is `flows_artifact_gets`. Only the supplied
filesystem and memory implementations update them. `RemoteArtifacts` does not
import or update metrics.

A `CombinedArtifacts` read served by the remote tier after a local miss
increments no get counter. Under `all` or `toplevel`, the read-through
write-back calls the local store and increments `flows_artifact_puts`. Under
`minimal`, a miss produces no metric update unless the local address was
corrupt and required repair. A successful local hit increments
`flows_artifact_gets` once.

## Package boundary

The root uses Effect's `FileSystem` and `HttpClient` contracts and bundles for
the browser. See [browser support](/architecture/browser-support). The package
owns no SQL tables and needs no migration.

Reclaiming published blobs never happens as a side effect of a store call. The
filesystem store sweeps only stale scratch and lock files. The mark policy and
grace period for published blobs belong to `@smthrs/engine-store`; see its
[API reference](/api/engine-store) for artifact publication ordering.
