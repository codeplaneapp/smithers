---
title: "Contract"
description: "Canonical flow-key derivation and stored-key validation"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/keys/docs/contract.md"
---

[`@smthrs/keys`](/reference/api/) owns one current derivation and the exact stored
representations this release can validate. `deriveKey` maps canonical key
material to `key1_` plus a SHA-256 digest. `KeyV1` and `StoredKey` validate that
wire value unchanged; they never hash it. The compatibility `Key` schema still
derives, so key-shaped text decoded through `Key` becomes a different key.
Unknown versions are rejected until their complete format is implemented.
Canonical serialization belongs to `@smthrs/canonical`, hashing belongs to
`@smthrs/crypto`, and domain-specific material belongs to each caller.
