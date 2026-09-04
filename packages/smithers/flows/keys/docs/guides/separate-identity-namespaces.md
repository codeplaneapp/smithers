---
title: "Separate identity namespaces"
description: "Add a domain and a material version to key material so two protocols never share an identity, and so a change to what you hash re-keys on purpose."
sidebar:
  order: 3
---

`deriveKey` hashes the document you give it and nothing else. There is no
implicit namespace, no caller identity, and no module name mixed in. Two
subsystems that both hash `{ id: 1 }` derive the same key, because it is the
same document.

That is fine until the two share a store. Then one subsystem's cache row is the
other's cache row, and a lookup returns a value that was never computed for it.
Domain separation is the caller's job, and it costs two fields.

## Add a domain and a version

Put a stable domain string and a material version in every structured input:

```ts
import { deriveKey } from "@smthrs/keys"

const compileKey = (target: string) => deriveKey({ domain: "build/compile", version: 1, target })

const testKey = (target: string) => deriveKey({ domain: "build/test", version: 1, target })
```

`compileKey("web")` and `testKey("web")` now derive different keys, and they
will keep doing so no matter how the rest of the material evolves.

Pick the domain once and freeze it. It is part of your persisted identity, so
renaming it re-keys everything under it. Use a name that will survive a
refactor: the protocol, not the module.

## Use the version to re-key on purpose

The `version` field is a material-schema version, not your package version.
Bump it exactly when the meaning of the fields beside it changes, so old keys
and new keys occupy separate namespaces instead of colliding:

```ts
// v1 keyed on the target alone.
const v1 = { domain: "build/compile", version: 1, target: "web" }

// v2 adds the flags. A v2 key must never equal a v1 key for the same target.
const v2 = { domain: "build/compile", version: 2, target: "web", flags: ["--minify"] }
```

Without the bump, adding a field changes some keys and leaves others alone, and
which is which depends on whether the new field happened to be present. With
it, every v2 key is new and every v1 row keeps meaning what it meant.

## Tag the shape when one namespace holds several

Where one domain covers more than one kind of key, tag the kind. A tag is
cheap, and it is what keeps two shapes from aliasing when one happens to spell
the other. [`@smthrs/engine`](/api/engine) keys every action dispatch this way:
the material carries a `kind` for whether it is a run-local or cross-run
identity, and a `form` for whether the idempotency key was a declared string or
a caller-owned object, precisely because the two forms build the `input` field
from different material and would otherwise digest identically.

```ts
import { deriveKey } from "@smthrs/keys"

const declaredKey = (name: string, idempotencyKey: string) =>
  deriveKey({ domain: "build/step", version: 1, form: "declared", input: { name, idempotencyKey } })

const callerKey = (input: Record<string, string>) =>
  deriveKey({ domain: "build/step", version: 1, form: "caller", input })
```

## What a domain does not buy you

A domain separates namespaces. It does not make a key secret, and it does not
make derivation collision-proof beyond SHA-256's own guarantee. Anyone who can
guess your domain, your version, and your fields can derive your keys, because
the derivation is public and unkeyed. See
[Key derivation](../concepts/key-derivation.md).
