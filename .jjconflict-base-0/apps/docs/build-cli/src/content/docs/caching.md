---
title: "Caching"
description: "Executes PACKAGE.ts target graphs with content-addressed caching"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/build/build-cli/docs/caching.md"
---

## The cache directory

Every workspace command takes `--cache-dir`, a workspace-relative directory
holding the result cache, the content-addressed artifact store, and rule scratch
files. `create-app` is the exception: it scaffolds a directory and takes only
`--template` and `--link`.

Precedence is the flag, then the workspace declaration (the `Config` export from
the root `PACKAGE.ts`, or `S.Cache({ directory })` in `WORKSPACE.ts`), then
`.flows`. An empty value, an absolute path, and any `..` segment fail the
command.

When the declaration sets `gitignored: true`, the command first ensures the root
`.gitignore` carries an entry for the directory, creating the file when it is
absent and leaving it alone when an equivalent entry is already there.

Discovery never lists a path inside the directory, so its content cannot feed
input discovery or a digest, and the directory name itself never enters a cache
key.

## The content-addressed store

A target's declared `outDir` trees and `outFile` files are captured into
`<cache-dir>/cas`, keyed by the sha256 of their bytes. A blob is never trusted
by name: an existing one is re-verified against its digest and rewritten from
the freshly produced file, so a rebuild heals a tampered store instead of
leaving it poisoned for every later run.

Restoring is bounded on both ends. A manifest read back from the cache is
untrusted input, so every path it names is confined to the node's _declared_
outputs before anything is written, and every blob is verified before the tree
is materialized. Publication is a rename swap: the tree is built whole as a temp
sibling, the previous tree is moved aside, the new one takes its place, and a
failure of the swap puts the previous tree back rather than leaving the output
absent.

The capture walk holds to declared ceilings — depth, entry count, path bytes,
per-file bytes, and total bytes — and a tree that crosses one aborts the capture
before anything reaches the store, naming the path and the limit.

## The remote cache

A workspace may declare a shared cache. In PACKAGE.ts:

```ts
export const cache = S.RemoteCache.make({
  endpoint: "https://cache.example.com",
  read: S.Secret("SMITHERS_CACHE_READ_TOKEN"),
  write: S.Secret("SMITHERS_CACHE_WRITE_TOKEN")
})
```

In `WORKSPACE.ts` the same declaration is the `remote` field of the cache:

```ts
cache: S.Cache({ directory: ".flows", remote: S.RemoteCache.make({ ... }) })
```

`make` accepts exactly `endpoint`, `token`, `read`, and `write`, and refuses any
other own property. `token` and `read` name the same slot and are mutually
exclusive: one credential for both directions, or a read credential plus a
`write` one. Omitting both defaults the read credential to
`SMITHERS_CACHE_TOKEN`. Endpoints must be absolute HTTPS URLs carrying no
userinfo.

`SMITHERS_CACHE_URL` overrides the declared endpoint per host; it does not
change which credentials the workspace declared, so a split survives an
override. Token values are read from the named environment variable only at the
moment an outbound request is built, never held in a serializable field, never
part of any key, and removed before target tools spawn.

`SMITHERS_CACHE_NAMESPACE` names the trust domain this process publishes into.
Set, results are published under `<namespace>/<key>`; unset means the trusted
domain, which is what a post-merge build has. Which domain a job belongs to is a
property of the job, not of the workspace, so it comes from the environment
rather than from a declaration.

The CLI reads through HTTP `/ac`: a local hit avoids the network, a remote hit
hydrates the local entry, and a put publishes to both tiers. A remote failure
warns once and disables the remote for the rest of the process. A `409`
conflict warns and keeps the first published result. A publication the
credential may not perform stops publication only, because an untrusted job is
meant to read everything and publish nothing.

Both modes resolve the remote the same way and pass it to the same store.
