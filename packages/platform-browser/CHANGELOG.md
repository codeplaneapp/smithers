# @smthrs/platform-browser

## [Unreleased]

## 1.0.0-rc.0

### Added

- `BrowserFileSystem`: Effect's `FileSystem` over a ZenFS-shaped promises API,
  taken as a structural slice so no `@zenfs/core` dependency is introduced.
  `make` builds the service; `layer` provides it and carries `@smthrs/kernel`'s
  whole-filesystem isolation attestation, which says the volume behind the
  promises object cannot address any path outside itself.
- `BrowserChildProcessSpawner`: Effect's `ChildProcessSpawner` over a just-bash
  interpreter instance, taken as the same kind of structural slice. Runs are
  serialized, the command line is rendered with `@smthrs/kernel`'s
  `CommandLine.render` (the same string the `proc:spawn` grant is checked
  against), and every capability just-bash lacks is reported as a
  `PlatformError` rather than as silence: process pipelines, additional file
  descriptors, a custom shell path, a detached process, and a streaming stdin
  are all refused at spawn time. The `stdout`/`stderr` dispositions keep their
  Node meaning, applied to captured text.
- `BrowserServices`: the aggregate layer mirroring `NodeServices`, providing
  `ChildProcessSpawner`, `FileSystem`, and `Path` from one call.
- `BrowserHost`: the complete closed five-tag Host bundle for a tab.
  `layer({ bash, fs, jj })` adds the wasm-backed `Jj` over the compiled
  `flows_jj.wasm` and the synchronous slice of the same mount, plus Effect's own
  `FetchHttpClient.layer` configured with `RequestInit { redirect: "manual" }`
  so the runtime never follows a redirect behind the capability kernel's grant
  check. A jj-less host composes `BrowserJj.layerUnsupported` explicitly; the
  bundle never installs it silently.

### Changed

- Interruption, `Effect.timeout`, scope closure, and `handle.kill()` now abort
  the interpreter through just-bash's `AbortSignal` instead of waiting for an
  uninterruptible boundary to finish. `isRunning` tracks the run rather than
  being `false` by the time a caller can observe it.
- The serialization permit is held until the interpreter promise itself
  settles, abort included, so a second interpreter cannot start on top of a
  call that is still writing to the mount. `JustBashLike.exec` now states the
  matching requirement: the returned promise must settle once the signal
  aborts.
- An aborted run is reported on the handle as a `PlatformError` naming the
  abort. `exitCode`, `stdout`, `stderr`, and `all` no longer replay the
  worker's interrupt, which silently cancelled the caller's own fiber.
- `JustBashLike.exec` options gained `signal` and `replaceEnv`. just-bash merges
  `env` into its own environment unless asked to replace it, so the adapter now
  asks for replacement whenever the caller did not set `extendEnv: true`, which
  is Effect's own default.
- `kill` rejects `forceKillAfter`, which this backend cannot honour, and
  documents `killSignal` as meaningless for an interpreter.
- `cwd` is validated as a directory rather than merely as an existing path, so a
  regular file is refused instead of being handed to the interpreter.
- `BrowserFileSystem` honours the options it used to drop: `readDirectory`
  walks the tree for `recursive`, `access` answers `readable` and `writable`
  from the reported mode bits, `makeDirectory` forwards `mode`, and `realPath`
  canonicalizes instead of returning its input, which is what makes
  `@smthrs/kernel`'s symlink boundary resolution real over this host.
- `exists` reports `false` only for a path that is absent; every other backend
  failure now propagates, matching effect's own derivation.
- Backend errors map onto the `PlatformError` tag that carries their meaning:
  `EACCES` and `EPERM` become `PermissionDenied`, `EISDIR`, `ENOTDIR`, and
  `ELOOP` become `BadResource`, and `EBUSY` becomes `Busy`, alongside the
  existing `ENOENT` and `EEXIST` mappings.
- `stream` refuses an `offset`, `bytesToRead`, or `chunkSize` that is not a
  whole byte count instead of clamping it, caps a single chunk allocation at
  64 MiB, and refuses a backend that reports reading more bytes than the buffer
  it was handed.
- `ZenFsPromisesLike` gained optional `lstat` and `realpath` members, used for
  recursive listing and canonicalization when the backend provides them.
- `BrowserChildProcessSpawner.make` is public, matching `BrowserFileSystem.make`.
