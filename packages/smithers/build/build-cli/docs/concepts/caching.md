---
title: "Caching"
description: "The cache directory, what a content key covers, the content-addressed store and its guarantees, and the read-through remote cache with its credentials and trust domains."
sidebar:
  order: 4
---

A cached target does not run. Everything below is about deciding when that is
safe.

## The cache directory

Every workspace command takes `--cache-dir`, a workspace-relative directory
holding the result cache, the content-addressed artifact store, and rule
scratch files. `create-app` is the exception: it scaffolds a directory and
reads no workspace.

Precedence is the flag, then the `S.Cache({ directory })` of the workspace
declaration, then `.flows`. An empty value, an absolute path, and any `..`
segment fail the command.

Keep the directory out of version control. Nothing in it is an input to
anything: discovery never lists a path inside it, so its contents cannot feed
input discovery or a digest, and the directory's name never enters a key.

## What a key covers

A target's content key is a sha256 over four fields, and a change to any of
them is a different target as far as the cache is concerned.

**`body`** is the target's persistent identity: its rule, its flow tag, its
schema identity, the verb-effective mode, the working directory, its declared
output roots, and two format salts that let an executor change semantics
without serving stale results.

**`inputs`** is everything the run depends on:

- `attrs`, canonicalized so a target reference becomes that dependency's key
  and a declared input becomes a content digest;
- the expanded declared inputs and their file digests;
- the dependency rows, so a dependency's result is part of the dependent's
  identity;
- `ambient`: the host's Node version, platform, and architecture, the
  lockfile digest, and the implementation fingerprint.

**`layers`** carries the resolved environment, such as a Nix closure hash.

**`capabilities`** carries what the target was allowed to do.

The implementation fingerprint is worth calling out: it digests the bytes of
the executor and rule implementations that will run the plan. Editing the
executor therefore re-keys every target, which is why a rule fix is never
served a result the old rule produced. A rule implementation's function
identity is deliberately absent from the key, because closure identity carries
per-process entropy and could never answer a cross-process hit.

`--plan` prints a preview of this material per target, and `SMTHRS_DEBUG_KEYS`
names a file every node's key material is appended to when a hit you expected
did not happen.

## The content-addressed store

A target's declared `outDir` trees and `outFile` files are captured into
`<cache-dir>/cas`, keyed by the sha256 of their bytes.

A blob is never trusted by name. An existing one is re-verified against its
digest and rewritten from the freshly produced file, so a rebuild heals a
tampered store instead of leaving it poisoned for every later run.

Restoring is bounded on both ends. A manifest read back from the cache is
untrusted input, so every path it names is confined to the node's declared
outputs before anything is written, and every blob is verified before the tree
is materialized. Publication is a rename swap: the tree is built whole as a
temporary sibling, the previous tree is moved aside, the new one takes its
place, and a failed swap puts the previous tree back rather than leaving the
output absent.

The capture walk holds declared ceilings on depth, entry count, path bytes,
per-file bytes, and total bytes. A tree that crosses one aborts the capture
before anything reaches the store, naming the path and the limit.

## The remote cache

A workspace may declare a shared cache as the `remote` field of its cache
declaration:

```ts
import { Smithers as S } from "@smthrs/targets"

export const Workspace = S.Workspace("demo", {
  cache: S.Cache({
    directory: ".flows",
    remote: S.RemoteCache.make({
      endpoint: "https://cache.example.com",
      read: S.Secret("SMITHERS_CACHE_READ_TOKEN"),
      write: S.Secret("SMITHERS_CACHE_WRITE_TOKEN")
    })
  })
  // the rest of the declaration
})
```

`make` accepts exactly `endpoint`, `token`, `read`, `write`, and
`publicReadToken`, and refuses any other own property. `token` and `read` name
the same slot and are mutually exclusive: one credential for both directions,
or a read credential plus a `write` one. Omitting both defaults the read
credential to `SMITHERS_CACHE_TOKEN`. An endpoint must be an absolute HTTPS
URL with no userinfo, query, or fragment.

`publicReadToken` is a committed literal that can only read the one
repository's cache. It is exclusive with `token` and `read`: reads use the
literal and `write` names the publishing credential. This is the same posture
as a read-only access token in other build caches, which is why it may live in
the repository.

### The transport

The CLI reads through HTTP `/ac`. A local hit avoids the network, a remote hit
hydrates the local entry, and a put publishes to both tiers.

- A remote failure warns once and disables the remote for the rest of the
  process, so a flaky cache slows a build instead of failing it.
- A `409` conflict warns and keeps the first published result.
- A publication the credential may not perform stops publication only. An
  untrusted job is meant to read everything and publish nothing.

### Overrides and trust domains

`SMITHERS_CACHE_URL` overrides the declared endpoint for one process. It does
not change which credentials the workspace declared, so a split read and write
pair survives an override.

`SMITHERS_CACHE_NAMESPACE` names the trust domain this process publishes into.
Set, results are published under `<namespace>/<key>`; unset means the trusted
domain, which is what a post-merge build has. Which domain a job belongs to is
a property of the job rather than of the workspace it builds, which is why it
comes from the environment and not from a declaration.

A result produced outside an enforced sandbox is evidence for this machine
only and never reaches the shared tier. See
[Target execution](./execution.md).

### Credentials

Token values are read from the named environment variable only at the moment
an outbound request is built. They are never held in a serializable field,
never part of any key, and stripped from the environment of every spawned
tool. The process entry point additionally captures and deletes
`SMITHERS_CACHE_URL` and `SMITHERS_CACHE_TOKEN` before any declaration
evaluates.

For the walkthrough, see
[Share results through a remote cache](../guides/share-a-remote-cache.md).
