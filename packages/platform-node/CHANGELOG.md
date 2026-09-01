# @smthrs/platform-node

## [Unreleased]

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added `AtomicFileSystem`, the descriptor-relative filesystem `NodeHost` puts
  in its filesystem slot. Every operation pins the workspace root, walks each
  component with `O_NOFOLLOW`, and performs the final syscall relative to a
  pinned parent descriptor, so a symlink swapped in after authorization cannot
  redirect it. **It is a new host prerequisite**: a POSIX host with CPython 3 at
  `/usr/bin/python3` whose `os` module supports `dir_fd` for `open`, `mkdir`,
  `readlink`, `rename`, `rmdir`, `stat`, and `unlink`. The layer builds without
  one and then fails every guarded filesystem call closed with
  `PermissionDenied`; `AtomicFileSystem.layerWith({ executable })` points it at
  an interpreter installed elsewhere. Windows is unsupported. `open`, `stream`,
  `sink`, `watch`, `copy`, `copyFile`, `link`, `symlink`, `access`, `chmod`,
  `chown`, `truncate`, `utimes`, and the `makeTemp*` family are refused under the
  capability decorator rather than reverting to a path-based call.
- Added `ProcessReaper`, which kills the process groups a crashed incarnation of
  the same host abandoned, and `HostLiveness`, which answers whether a recorded
  run owner is still running on this host.
- Added `NodeHost.layerAt` and `NodeHost.layerContainedAt`, the two layers with
  `Jj` bound to one absolute repository root rather than the process working
  directory, and `NodeHost.layerContained`, which turns on process containment.
- Added `AtomicFileSystem.Options.concurrency` and
  `AtomicFileSystem.Options.timeoutMs`, with `defaultConcurrency`
  (`os.availableParallelism()`) and `defaultTimeoutMs` (300000). Each operation
  is one CPython fork, so without a ceiling an unbounded fan-out started one
  interpreter per entry; without a timeout a helper that never answered held the
  fiber until the run itself was interrupted.
- Added `ProcessReaper.StartTime`, `ProcessReaper.SystemOptions`,
  `ProcessReaper.posixSystemWith`, `ProcessReaper.defaultPsExecutable`, and
  `System.refuseTarget`.
- Added `NodeHost.ContainedOptions`.

### Changed

- Extracted the package from the dissolved `@smthrs/host`. `NodeHost` moved here
  unchanged in behaviour; `NodeJj` had already moved to `@smthrs/jj` and is
  composed from there.
- `AtomicFileSystem.stat` now reports the raw `st_mode`, file-type bits
  included, matching `@effect/platform-node`. It previously masked the value
  down to its permission bits, so `mode & S_IFMT` answered zero through the
  atomic path and correctly through the raw one.
- Atomic system errors now carry `syscall`, which
  `@effect/platform-node` sets on every system error it reports.
- `AtomicFileSystem.glob` now implements the grammar rather than translating it
  into a regular expression: brace alternation, trailing-slash directory-only
  matching, `**` spanning zero segments, the dotfile rule, subtree-pruning
  exclusions, and absolute excludes rewritten against the glob root all now
  agree with `node:fs.glob`. Matching is linear in the candidate's length, so a
  pattern of repeated `*x` fragments no longer costs exponential backtracking. A
  pattern past 4096 characters or 64 brace alternatives is a `BadArgument`; a
  character class that opens and never closes is literal text, and `[]]` is a
  class holding one bracket rather than an error.
- `AtomicFileSystem.remove(path, { force: true })` now succeeds for a path whose
  ancestors do not exist, as `fs.rm` does. Recursive removal walks iteratively
  with an explicit descriptor stack, bounded at 512 levels and 100000 entries,
  reading each directory incrementally.
- `AtomicFileSystem` reads every option except `executable` once, when the layer
  is built, so a mutated options object cannot change a ceiling under a running
  host. The concurrency ceiling is one semaphore per layer.
- `NodeHost.layerContained` and `layerContainedAt` no longer accept
  `ContainedSpawner.Options.platform`. A caller-supplied `"win32"` used to win
  the option spread on a POSIX host, recording `pgid: null` for a child that
  really did lead a group; the reaper then refused that record as `no-group` and
  the orphan outlived every incarnation.
- `ProcessReaper` refuses a record it cannot verify instead of signalling it. An
  absent, unanswerable, or unparseable `ps` used to read as "no refusal" and a
  recycled process group was `SIGKILL`ed on the strength of a record the host
  could not check. `System.startedAtMs` now returns a tagged `StartTime`, the
  probe runs from an absolute `/bin/ps` with `LC_ALL=C`, an empty-ish
  environment, and a finite timeout, and the new `identity-unverified` refusal
  keeps the record for an incarnation that can answer.
- `ProcessReaper` validates a durable record's numbers before signalling them.
  `pgid: 0` reached `process.kill(-0, "SIGKILL")`, which signals this host's own
  process group; POSIX now requires a safe `pgid` above 1 equal to `pid`, and
  Windows requires `pgid: null`, with the check repeated inside each `killTree`.
- Windows records now reach `taskkill` through `reap`. They carry `pgid: null`,
  which was refused as `no-group` before `killTree` was consulted, so
  `windowsSystem` was unreachable and every Windows orphan was retired
  unsignalled. Windows remains outside the 1.0.0-rc.0 support contract and this
  path is unsupported best-effort.
- Moved the package's published documentation into `docs/` and `Package.ts`.
  `docs/pages/api/platform-node.md` is generated from package sources and said,
  until now, that the package "adds no implementation of its own".

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
