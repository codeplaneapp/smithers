---
title: "Testing"
description: "Strict SHA-256 hashing with injected and synchronous Effect entry points"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/crypto/docs/testing.md"
---

The package-owned Crypto suite pins published SHA-256 and UTF-8 vectors, a
million-byte vector, malformed Unicode, direct and schema APIs, and
synchronous, injected, and Web Crypto parity. Property tests compare both entry
points over arbitrary valid text and byte views. Adversarial service tests cover
input snapshots, malformed or mutable output, missing services, exact stable
failures with preserved causes, diagnostic redaction, and irreversibility.
