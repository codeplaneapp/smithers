---
title: "Installation"
description: "Install @smthrs/canonical, its runtime requirements, its two import forms, and the subpaths the export map blocks."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/canonical/docs/installation.md"
---

## Install the package

```bash
pnpm add @smthrs/canonical
```

The package requires Node.js 22.19.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. It has one runtime dependency,
[`effect`](https://effect.website), which supplies the `Schema` module the
`Canonical` codec is built on.

The serializer itself is written in this package. It has no native bindings,
no platform layer, and no filesystem or network access, so it runs unchanged in
Node.js, in Bun, and in a browser bundle. The package's own suite runs under
both Node.js and Bun.

## Import forms

The root entry point exports the whole surface:

```ts
import { Canonical, CanonicalError, canonicalize } from "@smthrs/canonical"
import type { CanonicalErrorCode } from "@smthrs/canonical"
```

The schema is also importable from its own subpath:

```ts
import { Canonical } from "@smthrs/canonical/Canonical"
```

`canonicalize` and `CanonicalError` are only available from the root, because
the serializer lives under a private subpath.

## What is not public

Two subpath forms are blocked in the export map:

- `@smthrs/canonical/internal/*`, which holds the serializer.
- `@smthrs/canonical/*/index`.

`@smthrs/canonical/package.json` is exported. `MAX_CANONICAL_DEPTH` lives in
the private module and is not part of the public surface; the bound it names is
documented as 10,000 levels in
[The serialization contract](/serialization/#depth).

## Use it with the rest of Smithers

Most Smithers packages reach canonical JSON through a package that already
depends on it, so you rarely add this one directly:

- [`@smthrs/keys`](https://keys.smithers.sh/reference/api/) derives a `key1_` flow key by canonicalizing key
  material and hashing it.
- [`@smthrs/core`](https://core.smithers.sh/reference/api/) exposes `Digest.canonical` for synchronous
  fingerprints inside pure constructors.
- [`@smthrs/crypto`](https://crypto.smithers.sh/reference/api/) supplies the SHA-256 service those
  derivations hash with.

Add `@smthrs/canonical` directly when you are computing your own digest and
none of those fits.

## Next step

Derive a content key end to end in the [Quickstart](/quickstart/).
