---
title: "Serialization"
description: "RFC 8785 canonical JSON as an Effect Schema"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/canonical/docs/serialization.md"
---

Decoding through `Canonical` produces RFC 8785 JSON. The wrapped `canonicalize` library sorts object keys, preserves array order, uses deterministic number formatting, and rejects inputs that cannot produce valid canonical JSON. The wrapper additionally rejects lone Unicode surrogates.
