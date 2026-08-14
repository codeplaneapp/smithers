# @smthrs/time-travel — src

Snapshots, structured diffs (`diff.js`), forks, checkpoint replay (`replay.js`),
timelines, and VCS-tagged run history — plus the destructive rewind machinery:
`jumpToFrame.js` (per-run lock, rate limit, durable audit trail, startup crash
recovery) and the attempt-scoped reset flows `timetravel.js`, `retry-task.js`,
and `revert.js`.

## Layout

- One export per file, with type-only `.ts` sidecars (`JumpResult.ts`,
  `TimeTravelOptions.ts`, …) next to the `.js` implementations.
- Subdirs `snapshot/`, `fork/`, `timeline/`, `vcs-version/` pair Effect
  implementations (`*Effect.js`) with a Promise facade in their `index.js`.
- `index.js` is the package barrel; blocks between
  `@smithers-type-exports-begin/end` markers are tool-managed — do not edit.
- `metrics.js` backs the `./metrics` subpath, re-exporting the observability
  metric definitions (`snapshotsCaptured.js`, `replaysStarted.js`, …).

## Gotchas

- `package.json` has a `"./*"` wildcard export, so EVERY file here is a public
  deep-import subpath — renames and moves are API breaks.
- `SmithersDb` adapter methods return thenable RunnableEffects: both
  `await adapter.x()` and `yield* adapter.x()` work; no `Effect.runPromise`
  wrapping is needed. VCS effects from `@smthrs/vcs` are plain
  Effects and DO need `Effect.runPromise(... Effect.provide(BunContext.layer))`.
- `recoverRewindAuditsAtStartup.js` is deliberately not in the barrel —
  `packages/server/src/serve.js` deep-imports it.
