---
title: "Testing"
description: "Canonical flow-key derivation and stored-key validation"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/keys/docs/testing.md"
---

The [`@smthrs/keys` suite](/reference/api/) freezes `key1_` wire vectors, stored-key
identity and version rejection, canonical equality properties, typed host
failures, diagnostic redaction, irreversibility, and browser-safe source
imports. The repository browser and Bun gates run the same public package and
wire format.
