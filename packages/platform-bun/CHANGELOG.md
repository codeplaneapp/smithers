# @smthrs/platform-bun

## [Unreleased]

## [1.0.0-rc.0] - 2026-09-01

### Added

- Initial extraction from the dissolved `@smthrs/host`. `BunHost` and
  `BunFileSystem` moved here unchanged in behaviour; `BunJj` had already moved
  to `@smthrs/jj` and is composed from there.
- `BunHost.layerAt` and `BunHost.layerContainedAt` bind `Jj` to one absolute
  repository root, so a host does not inherit the process working directory.
- `BunFileSystem.layer` is `@smthrs/platform-node`'s `AtomicFileSystem.layer`,
  the same implementation behind `NodeHost`'s filesystem slot. Guarded path
  operations under `@smthrs/kernel`'s `FileSystem.layer` are therefore
  descriptor-relative and no-follow on Bun, not failing closed. The host needs a
  CPython 3 interpreter at `/usr/bin/python3`; `BunFileSystem.layerWith` names a
  different one, and `BunHost` re-exports `AtomicFileSystem` for parity with
  `NodeHost`.
- `engines.bun` declares the supported Bun floor, `>=1.3.0`.

### Changed

- `BunHost.implementationIds` names `@smthrs/platform-node/AtomicFileSystem` for
  the filesystem slot, which is the module actually behind it, and writes every
  key as a literal so reordering `HostServiceIds` cannot mis-pair a slot with
  another slot's implementation. No planner reads the record yet, so the change
  invalidates no cached step.

### Removed

- `BunHttpTransport` is gone, and with it the dependency on
  `@smthrs/platform-browser` that existed only to borrow a `fetch`-backed
  transport. An outgoing request is Effect's `HttpClient`, and `BunHost.layer`
  now provides `@effect/platform-bun`'s own `BunHttpClient.layer` with
  `RequestInit { redirect: "manual" }`, so nothing follows a redirect behind
  the capability kernel's back. `BunHost.implementationIds` names
  `@effect/platform-bun/BunHttpClient` for the network slot.

- `BunShell` is gone, and with it the hand-rolled runtime detection that chose
  between `Bun.spawn` and `node:child_process`. `BunHost.layer` provides
  `@effect/platform-bun`'s `ChildProcessSpawner`, which is
  `@effect/platform-node-shared`'s implementation re-exported, the same code on
  both runtimes, so there is nothing left to detect.
