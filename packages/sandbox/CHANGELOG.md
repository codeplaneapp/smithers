# @smthrs/sandbox

## [Unreleased]

### Changed

- `RemoteSandbox` is now `RemoteChildProcessSpawner`, at
  `@smthrs/sandbox/RemoteChildProcessSpawner`. It was always a remote
  implementation of Effect's `ChildProcessSpawner`; it is now named like one,
  next to `NodeChildProcessSpawner`, `BunChildProcessSpawner`, and
  `BrowserChildProcessSpawner`. The identity strings follow the module path:
  the provider tag key is now
  `@smthrs/sandbox/RemoteChildProcessSpawner/Provider` and `ProviderError`'s
  `_tag` is `@smthrs/sandbox/RemoteChildProcessSpawner/ProviderError`. This
  contradicts the "every schema `_tag` is unchanged" note below on purpose: the
  package is pre-release, and a durable id that lies about where its module
  lives is worse than a break nobody has recorded runs against yet. The test
  double follows the module: `TestSandbox` / `TestSandboxProvider` /
  `TestSandboxState` are `TestRemote` / `TestRemoteProvider` /
  `TestRemoteState`. `SandboxHealth` and the package name are unchanged.
- `RemoteChildProcessSpawner`'s divergences from a local spawner — no stdin, no
  signals, no process identity, no pipeline routing between processes, no extra
  file descriptors, no custom shell or detached process — are now stated in the
  module header the way `BrowserChildProcessSpawner` states its own, rather than
  living only in the rejection messages. The header also names the two
  divergences that cannot be reported as a failure at all: `extendEnv` is
  ignored, because the remote session's ambient environment never crosses the
  seam, and `isRunning` turns `false` when a caller observes `exitCode` rather
  than when the remote process ends. `PlatformError.module` is
  `"ChildProcess"`, matching the sibling spawners.
- `RemoteChildProcessSpawner` now adapts a provider onto Effect's
  `ChildProcessSpawner` rather than the deleted `Shell` service. A provider
  hands back a started remote process in the same three pieces a child process
  has — `stdout`, `stderr`, `exitCode` — and `layer` (formerly `layerShell`)
  normalizes provider failures onto `PlatformError`. Piping stdin and killing by signal are declared
  unsupported rather than silently dropped; a remote process ends by closing its
  scope.
- `RemoteChildProcessSpawner.layer` now applies output dispositions and sinks,
  and rejects command-supplied stdin, additional file descriptors, custom shell
  paths, detached processes, and non-default pipeline routing with
  `BadArgument` instead of changing or dropping their semantics.
- `ProviderError` carries its own closed `ProviderErrorCode` set (`aborted`,
  `timeout`, `unavailable`, `spawn_error`, `unknown`) instead of borrowing the
  shell's.
- The package now depends on `@smthrs/kernel` — for `CommandLine.render` alone —
  instead of `@smthrs/host`.
- Split remote execution and sandbox health into focused model, service,
  adapter, probe, and layer files without changing public imports.

### Added

- Split remote execution and `SandboxHealth` out of `@smthrs/host` into their
  own package. Every schema `_tag` was unchanged by that move: they are durable
  identity, not source location. The rename above is the one deliberate
  exception, taken while the package is pre-release.
