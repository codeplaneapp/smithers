# @smthrs/platform-browser

## [Unreleased]

### Added

- Added `BrowserHost` and `BrowserHttpTransport`, moved out of `@smthrs/host`
  when that package dissolved. `BrowserHost.layer({ bash, fs })` is the complete
  closed five-tag Host bundle for a tab; the spawner is provided _over_ the
  filesystem and path layers, the way `NodeChildProcessSpawner` is, so the
  interpreter and the `FileSystem` service agree about what exists.

### Changed

- `BrowserHost.layer` now wires the real wasm-backed `Jj`: the options gained a
  required `jj: BrowserJjOptions` field — the compiled `flows_jj.wasm` module
  and the synchronous slice of the same mount `fs` exposes as promises. The
  bundle no longer installs `BrowserJj.layerUnsupported` silently; a jj-less
  host composes that layer explicitly.
- `BrowserHttpTransport` is gone. An outgoing request is Effect's `HttpClient`,
  and `BrowserHost.layer` now provides `FetchHttpClient.layer` directly with
  `RequestInit { redirect: "manual" }` — the same redirect policy, expressed
  against Effect's own service instead of a `flows` port. The package no longer
  fills a kernel-owned slot.

- `BrowserChildProcessSpawner` now renders a command with
  `@smthrs/kernel`'s `CommandLine.render` instead of its own always-quoting
  helper. The two had to agree and did not: the kernel writes the rendered line
  as the `proc:spawn` capability resource, so a grant read `ls` while the tab
  ran `'ls'`.
- Commands that request additional file descriptors, a custom shell path, or a
  detached process now fail with `BadArgument`; the browser adapter cannot
  preserve those semantics and no longer drops them silently.

### Added (initial extraction)

- Added `BrowserFileSystem`, moved out of `@smthrs/host`
  (`browser/BrowserFileSystem`): a `FileSystem` over a ZenFS-shaped promises
  API, taken as a structural slice so no `@zenfs/core` dependency is
  introduced. Two gaps in the host version are closed on the way across:
  `readFileString` and `writeFileString` are now wired up (`FileSystem.makeNoop`
  hardcodes both to `NotFound` instead of deriving them from
  `readFile`/`writeFile` the way `make` does, so they failed on files that
  plainly existed), and `writeFile`'s `flag`/`mode` are forwarded to the backend
  instead of dropped, so `{ flag: "a" }` appends rather than silently
  truncating.
- Added `BrowserChildProcessSpawner`, an implementation of `effect`'s
  `ChildProcessSpawner` over a just-bash interpreter instance. It carries over
  `JustBashShell`'s semantics — the serialized uninterruptible boundary, the
  refusal to accept stdin — and reports every capability just-bash lacks
  (signals, streaming output, process pipelines) as a `PlatformError` rather
  than as silence. The `stdout`/`stderr` dispositions keep their Node meaning:
  `"inherit"`/`"ignore"` yield an empty stream and a `Sink` is transduced
  through.
- Added `BrowserServices`, the aggregate layer mirroring `NodeServices`:
  `ChildProcessSpawner`, `FileSystem`, and `Path` from one call.
