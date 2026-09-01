/**
 * Browser implementation of Effect's `ChildProcessSpawner` service.
 *
 * A browser tab cannot fork a process. What it can do is run a command line
 * through an in-page bash interpreter — in practice **just-bash** — over the
 * same virtual filesystem `BrowserFileSystem` is mounted on. This module adapts
 * that interpreter into a `ChildProcessSpawner` layer so `ChildProcess`
 * commands work in the browser the way they do under `NodeChildProcessSpawner`.
 *
 * **The divergences are real and are not hidden.** just-bash runs here as a
 * buffered, run-to-completion API with no process table:
 *
 * - **No incremental output.** `spawn` runs the command to completion and the
 *   returned handle replays the captured output: `stdout` and `stderr` each
 *   emit at most one chunk, and `all` is `stdout` followed by `stderr` rather
 *   than a live interleaving. `isRunning` is therefore always `false` by the
 *   time a caller can observe it. The `stdout`/`stderr` dispositions still
 *   mean what they mean under `NodeChildProcessSpawner` — `"inherit"` and
 *   `"ignore"` yield an empty stream, and a `Sink` is transduced through —
 *   they are just applied to captured text rather than to a live readable.
 * - **No stdin.** just-bash `exec` accepts a string `stdin` option, but the
 *   adapter does not use it yet: `stdin` is a `Sink` that fails, and a command
 *   that supplies a `Stream` for stdin is rejected at spawn time rather than
 *   losing its input silently.
 * - **No signals.** just-bash `exec` accepts an abort `signal`, but the
 *   adapter does not use it yet, so each run executes inside a serialized,
 *   uninterruptible boundary: interruption and `Effect.timeout` both wait for
 *   the interpreter to finish before they report, and callers never observe
 *   completion while hidden mutation of the virtual filesystem is still
 *   running. `kill` fails for the same reason — the adapter has no signal to
 *   deliver.
 * - **No process identity.** `pid` is a per-layer counter, not an OS pid, and
 *   `unref` is a no-op: there is no parent process reference count in a tab.
 * - **No pipelines between processes.** A `PipedCommand` is rejected; write the
 *   pipeline as a single command line and let the interpreter parse the `|`.
 * - **No extra file descriptors.** `getInputFd` returns `Sink.drain` and
 *   `getOutputFd` returns `Stream.empty` — the same answer
 *   `NodeChildProcessSpawner` gives for a descriptor that was never configured.
 *   A command that explicitly configures one is rejected at spawn time.
 * - **No custom shell or detached process.** `shell: true` means the in-page
 *   bash interpreter, but a shell path and `detached: true` cannot be honored
 *   in a tab and are rejected.
 * - **`extendEnv` is ignored.** There is no ambient process environment in a
 *   tab to extend; only `env` reaches the interpreter.
 *
 * @since 0.1.0
 */
export * from "./JustBashLike.ts"
export * from "./layer.ts"
