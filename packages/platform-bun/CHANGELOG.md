# @smthrs/platform-bun

## [Unreleased]

### Added

- Initial extraction from the dissolved `@smthrs/host`. `BunHost`,
  `BunFileSystem`, and `BunHttpTransport` moved here unchanged in behaviour;
  `BunJj` had already moved to `@smthrs/jj` and is composed from there.

### Removed

- `BunHttpTransport` is gone, and with it the dependency on
  `@smthrs/platform-browser` that existed only to borrow a `fetch`-backed
  transport. An outgoing request is Effect's `HttpClient`, and `BunHost.layer`
  now provides `@effect/platform-bun`'s own `BunHttpClient.layer` with
  `RequestInit { redirect: "manual" }`, so nothing follows a redirect behind
  the capability kernel's back. `BunHost.implementationIds` names
  `@effect/platform-bun/BunHttpClient` for the network slot, which changes
  step-key identity for Bun hosts.

- `BunShell` is gone, and with it the hand-rolled runtime detection that chose
  between `Bun.spawn` and `node:child_process`. `BunHost.layer` provides
  `@effect/platform-bun`'s `ChildProcessSpawner`, which is
  `@effect/platform-node-shared`'s implementation re-exported — the same code on
  both runtimes, so there is nothing left to detect.
