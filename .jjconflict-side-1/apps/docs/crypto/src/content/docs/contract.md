---
title: "Contract"
description: "Strict SHA-256 hashing with injected and synchronous Effect entry points"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/crypto/docs/contract.md"
---

`@smthrs/crypto` owns the repository's SHA-256 policy and its only handwritten
implementation. `digest` sends a byte snapshot to an injected Effect `Crypto`
service; `digestSync` uses the package-owned synchronous FIPS 180-4 path. Both
reject unpaired UTF-16 surrogates, perform no Unicode normalization, and return
the same branded 64-character lowercase hexadecimal `Digest`. The API is
one-shot and whole-buffer; it does not offer streaming hashing. See the
[Crypto API contract](/reference/api/) for host requirements and failure codes.
