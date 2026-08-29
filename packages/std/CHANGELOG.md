# Changelog

## [Unreleased]

### Added

- Added a `test` flow bound to the repository's declared runner (`TestRunner`): it answers `{passed, failed[ids], parsed, tail}` read from the runner's own report — pytest, unittest and TAP are recognised — instead of twenty kilobytes of stdout, and `against: "base"` runs the same selection again on the pristine base commit in a detached worktree so `introduced`, `preexisting` and `fixed` come back from one call. The base is the engine's `refs/flows/capture-base`, then HEAD.
- Added a `Container` transport service, and `script`/`interpreter`/`args`/`stdin`/`container` inputs to `bash`. A script reaches its interpreter on standard input as data, so no caller composes `docker exec c bash -lc '…heredoc…'` again; the argv for a container is built by the injected transport, and a host with none refuses the call by saying so.
- Added the enclosing definition to every returned `grep` hit where the file's shape says so plainly, so a read window is computed rather than guessed; `symbols: false` turns it off.
- Added `startLine`/`endLine`/`expect` anchoring to `edit`, so an edit can target the span a prior `read` or `grep` hit reported instead of retyping it.
- Added `webfetch`, `websearch`, and `lsp` flows with provider-neutral service boundaries.
- Added one ripgrep-compatible search contract with native `rg` and in-process peer implementations, shared conformance coverage, context lines, case modes, globs, per-file match limits, hidden-file control, and files-with-matches output.

### Changed

- **Breaking.** `read` now returns raw file text in `content`, with the line numbers in the sibling `startLine`/`endLine` fields, instead of rendering `NNN\t` before every line. An anchor copied out of a read used to carry the gutter, so every `edit` built from a read missed and cells wrote string surgery to strip it. A byte-capped page now also ends on a whole line rather than a fragment that reads like an anchor.
- **Breaking.** `grep` results are match-centric: `limit` counts matches, each hit carries the `before`/`after` context that belongs to it, every context line belongs to exactly one hit, and a hit can no longer be dropped to make room for context. The flat `{file, line, text, kind}` rows are gone. A metacharacter pattern that finds nothing is retried as a literal, with `retriedAsLiteral` set.
- **Breaking.** `edit` matches its anchor byte-exactly or fails, and reports the file's real text at the nearest region with its line range. The tolerant apply cascade (trailing whitespace, then collapsed whitespace) is gone from the apply path and survives only as that diagnosis: a match that is not the caller's bytes is an edit nobody inspected, which silently dedented a guard on one instance and corrupted a file on another. `edit` also returns the applied hunk, and `edit`, `write` and `apply_patch` all restore permission bits a host write moved.
- Documented Bash's `stdoutTruncated`/`stderrTruncated` flags as the wire convention `@smthrs/harness/TruncatedOutput` reads, and stated in each stream's description that a truncated capture is a fragment that must not be written to a file.
- Allowed hermetic Bash invocations to use the resolved base directory as their working directory without declaring it as a read.
- Exempted `/dev/*` from the hermetic Bash path scan; process plumbing is not a workspace effect.

### Fixed

- Made `edit` report the nearest actual region on a miss, as raw quotable bytes rather than line-number-prefixed text; two benchmark runs burned their whole frame budget on whitespace-guessing loops. Prior art: `reference/opencode` `tool/edit.ts`, where this deviates deliberately by refusing to apply a loose match.

- Stopped `grep` and `glob` walks from descending into version-control, dependency, and cache directories; one `.git` descent held a frame for its whole evaluation ceiling.

- Reported a directory entry whose metadata cannot be read as a plain entry instead of failing the whole `ls` listing.
