# Nix dev shells

`S.Nix.DevShell({ flake, lock })` makes `flake.nix` and `flake.lock` the version authority for tools reached through `S.Nix.bin(name)`. Both file digests are key material.

Planning resolves a tool with `nix develop --command which name`. If `nix` is absent, planning records the typed refusal `host binary "nix" is not present on PATH`; it never reports a successful no-op or silently falls back to a host tool.
