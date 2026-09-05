---
title: "Nix dev shells"
description: "S.Nix.DevShell makes flake.nix and flake.lock the version authority behind every tool reached through S.Nix.bin."
sidebar:
  order: 3
---

`S.Nix.DevShell({ flake, lock })` makes `flake.nix` and `flake.lock` the
version authority for every tool a target reaches through `S.Nix.bin(name)`.
Both file digests are key material, so bumping a pin in the lock file re-keys
the targets that run out of the shell.

```ts
import { Smithers as S } from "@smthrs/targets"

const nix = S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") })
const golangciLint = S.Nix.bin("golangci-lint")
```

Planning resolves a tool with `nix develop --command which <name>`. On a host
with no `nix` on `PATH`, planning records the typed refusal
`host binary "nix" is not present on PATH`. It never reports a successful
no-op, and it never falls back to a host tool of the same name, because a
silent fallback would run a version the declaration never authorized.
