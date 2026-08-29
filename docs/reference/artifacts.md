# `@smthrs/artifacts`

This page is the public API reference for the **content-addressed artifact
store**: bytes addressed by their own SHA-256 digest.

It is the other half of the cache. [`@smthrs/step-cache`](step-cache.md) maps a
step key to a recorded result; a recorded result references its large outputs by
digest rather than inlining them, and those bytes live here. See
`docs/specs/Specs/Object Model.md` (the `Cache` service owns "a
content-addressed store for artifacts"), `docs/specs/Specs/Input.md` ("large
values enter by digest"), and `docs/specs/Concepts/Remote Cache.md`.

The package depends on `effect` and `@smthrs/crypto` and nothing else, owns no
tables, and needs no migration.

## ArtifactStore

`ArtifactStore` exposes `put`, `get`, `has`, and `findMissing`. `put` measures
the bytes and returns their address; `get` verifies that the stored bytes still
hash to the address it was asked for; `findMissing` is one batched probe whose
result is guaranteed to be a deduplicated subset of its input.

Three error tags, deliberately distinct. `ArtifactMissing` is the typed miss —
an ordinary, expected outcome that a second tier may satisfy. `ArtifactCorruption`
is an integrity violation: the bytes at an address no longer hash to it.
`ArtifactStoreError` is neither — a failing host, an unreachable tier, or an
address that is not usable as one — and stays retryable. Collapsing the three
into one code is exactly what makes a shared cache unsafe: a miss is fetchable,
corruption is not, and a host refusal says nothing at all.

Implementations: `makeFileSystem` / `layerFileSystem` over Effect's `FileSystem`
tag, `makeMemory` / `layerMemory` for tests and browser hosts, and
`makeNoop` / `layerNoop` per house style.

`layerFileSystem` publishes at `${directory}/${digest[0:2]}/${digest}` —
Bazel's `DiskCacheClient` fanout — with a default directory of `.flows/objects`.
Bytes land at a temp path in that directory, are fsynced where the host has
writable file handles, and are renamed into place. Temp names fold a random
per-instance token so two processes publishing one digest into a shared
workspace never collide. An existing blob is digest-verified on every
`put` — the objects directory is workspace-shared, so a remembered proof could
outlive the bytes it proved — and a mismatch or failing read falls through to
the atomic rewrite, healing the address.

## RemoteArtifacts

The shared tier, spoken over HTTP: `GET`/`PUT`/`HEAD /cas/{digest}` and
`POST /cas/findMissing`. Transport is Effect's own `HttpClient` tag, which the
capability kernel already decorates with `net:get`/`net:post` checks, so a
remote artifact fetch is permission-checked like any other egress.

Every download is digest-verified before it is returned. The shared tier is the
least trusted store there is — it is written by machines this one has never
met — so a mis-serving or compromised cache can waste a round trip but can never
substitute content.

The endpoint and its headers are **layer construction options**: a capability,
never an input. They are not hashed into a step key, not journaled, and not part
of any recorded result.

## CombinedArtifacts

Local first, remote second, with local write-back — Bazel's `CombinedCache`
shape. A local miss *or* a local corruption falls through to the shared tier,
and the write-back hands the correct bytes to `local.put`, whose own
verification rewrites the mismatched blob: a read-through heals a corrupt local
address rather than failing on it forever. Concurrent uploads of one digest
deduplicate in flight.

A `put` records locally first and its local digest is the answer: the upload to
the shared tier is opportunistic, and a refusal is dropped rather than
propagated. Failing there would fail whatever produced the bytes — a step's
`settle`, say — because a *cache* was unreachable. Nothing depends on that
upload; what gates a shared cache entry is the publication protocol's
`findMissing` → upload → confirm, run before the entry is published, so a
dropped upload costs one re-upload and never correctness.

## Entry points

The root is written against Effect's `FileSystem` and `HttpClient` contracts and
bundles for the browser (`pnpm run browser`). See
[browser support](../architecture/browser-support.md).

## Not here

Reclaiming published artifacts is an explicit `ArtifactGc.gc()` operation in
`@smthrs/engine-store`, backed by the host-local `ArtifactSweep` service
in this package. It is never a side effect of a store operation. The
`.tmp-*` sweep reclaims crash orphans, and artifact GC removes unreferenced
blobs only after its mark and grace-period checks. Chunked/resumable transfer
and a Bazel-style download policy are still ticketed in `.smithers/tickets/`.

See `docs/specs/Concepts/Remote Cache.md` and the
[`@smthrs/engine-store` reference](engine-store.md) for the publication ordering
that binds this store to the step cache.
