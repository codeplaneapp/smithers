# @smthrs/platform-node

## [Unreleased]

### Added

- Initial extraction from the dissolved `@smthrs/host`. `NodeHost` and
  `NodeHttpTransport` moved here unchanged in behaviour; `NodeJj` had already
  moved to `@smthrs/jj` and is composed from there.

### Removed

- `NodeHttpTransport` is gone. An outgoing request is Effect's `HttpClient`,
  and `NodeHost.layer` now provides `@effect/platform-node`'s
  `NodeHttpClient.layerUndici` directly. Undici installs no redirect
  interceptor, so every hop stays a separate request `@smthrs/kernel` can
  authorize. `NodeHost` re-exports `NodeHttpClient` for selective wiring.

- `NodeShell` is gone. Process execution is Effect's `ChildProcessSpawner`, and
  `NodeHost.layer` now provides `@effect/platform-node`'s implementation of it
  directly. The wrapper's one extra feature, `timeoutMs`, is `Effect.timeout`
  around any effect.
