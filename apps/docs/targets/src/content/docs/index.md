---
title: "@smthrs/targets"
description: "Typed legacy declaration rules and macros for smithers build"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/build/targets/docs/README.md"
---

This directory and the JSDoc in `src/` own the documentation for
`@smthrs/targets`. The package is private and has no page on the documentation
site, so nothing here is projected outward: `docs/` is where a reader of this
package looks, and `README.md` at the package root is the introduction that
points here.

- `api.md` is the hand-written tour of the module surface: what each layer is
  for and which module owns which contract.
- `rules.md` is the catalog inventory: every `Target.make` declaration in
  `src/`, the verbs it participates in, whether it is cacheable, whether it
  declares outputs, and which route executes it. It was generated from `src/`
  until the rc.0 docs-tooling dissolution deleted `scripts/docs.mjs` and
  `docs/Manifest.ts`, so it is hand-maintained today: adding a rule, changing
  its `kinds`, or making it cacheable is also an edit to that table.

The remaining pages are hand-written feature notes for one toolchain surface
each, kept beside the rules they describe:

- `go-targets.md` — `S.Go.Toolchain` and the Go rule family, and what keys a
  Go build.
- `local-repositories.md` — nested Smithers workspaces, their opaque input
  boundary, and `S.Repo.Target`.
- `nix.md` — `S.Nix.DevShell` as the version authority behind `S.Nix.bin`.
- `package-workspace.md` — what `S.Workspace` accepts: the Node trio, a
  `toolchains` list, or both.
- `stamps.md` — `S.Stamp` provenance values, why they resolve after the
  content key, and why secrets are refused.

Nothing drift-checks `rules.md` against `src/` at rc.0. `//packages/smithers/build/targets:docs`
is a `DocsParity` target over the package `README.md` only, so a stale row in the
inventory is caught by a reader, not by a gate. Declaring a generator target for
it again is the open follow-up.

Thirty-four reference pages for rules implemented here still live in
`packages/smithers/build/docs/reference/targets/`. Moving them under this directory and
having `packages/smithers/build` consume the artifact is the remaining half of the
colocation, and it is an edit in that package.
