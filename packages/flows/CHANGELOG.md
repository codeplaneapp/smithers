# @smthrs/flows

## [Unreleased]

## [1.0.0-rc.0] - 2026-08-31

### Added

- Added the complete engine aggregate exports and the supported Node SQLite
  `NodeRuntime`, including the batteries-included guarded host composition.
- Bound runtime storage and Jj operations to an explicit workspace and kept
  engine snapshot authority separate from action-facing Jj permissions.

### Removed

- Dropped the `Host` and `PlatformBrowser` namespaces. `@smthrs/host` was
  dissolved, and the `@smthrs/platform-*` bundles are deliberately not
  re-exported here — for the same reason `effect`'s index does not re-export
  `@effect/platform-node`, a platform bundle is chosen by the program that runs,
  not by the library it depends on. Import `@smthrs/platform-node`,
  `@smthrs/platform-bun`, or `@smthrs/platform-browser` directly.

## [0.1.0] - 2026-08-05

### Added

- Added the barrel package that re-exports every `@smthrs/*` engine package
  as a namespace — `Database`, `Engine`, `EngineStore`, `Host`, `Journal`,
  `Kernel`, `Keys`, `Plugin`, `Sync`, and `TimeTravel` — so one dependency
  gives you the whole engine surface without collapsing each package's
  `make` / `makeNoop` / `layerNoop` trio into a shared namespace.
- Added `namespaces`, the runtime list of the re-exported namespace names,
  which also gives the barrel's coverage gate a real denominator.
