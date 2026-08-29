# @smthrs/jj

## [Unreleased]

### Changed

- `Jj`'s error channel is now honest about the capability kernel: every method
  fails with `JjFailure` (`JjError | Permission.PermissionError`), and
  `workspaceAdd` additionally with `PlatformError` because the guarded
  implementation canonicalizes its destination path first. `@smthrs/kernel`
  decorates _this_ tag rather than redeclaring the interface behind one of its
  own, so there is one `Jj` interface and one `Jj` tag. The new dependency,
  `@smthrs/capability`, is a leaf that depends on nothing but `effect`, so this
  package stays browser-bundleable.
- Added `isJjError`, so a caller can tell "jj said no" from "the capability
  kernel said no" without matching on `_tag` by hand.

### Added

- `BrowserJj.layer({ fs, wasm })`: a working browser implementation of the
  `Jj` service. jj-lib v0.44.0 (pinned at `vendor/jj`) is compiled to a
  `wasm32-wasip1` reactor module by the `crates/flows-jj` shim crate, and a
  hand-written WASI preview1 host shim in `src/browser/` routes its filesystem
  syscalls (plus `random_get` for change-id entropy and `clock_time_get` for
  timestamps) to the same synchronous virtual-FS slice `BrowserFileSystem`
  uses — ZenFS in production, `node:fs` in tests. All six contract operations
  work against jj's Simple backend; git interop is out of scope (separate
  ticket). The wasm artifact ships at `wasm/flows_jj.wasm` and rebuilds via
  `pnpm run build:wasm`. `layerUnsupported` remains exported for hosts without
  a wasm module, and `not_installed` is now produced only on the TS side.
  Hosts own durability: call `fs.sync()` after operations (see README).
- Split the `Jj` contract, `JjError`, and the Node, Bun, and browser adapters
  out of `@smthrs/host` into their own package. The tag key `flows/host/Jj` and
  the error `_tag` `flows/host/JjError` are unchanged: they are durable
  identity, not source location.
