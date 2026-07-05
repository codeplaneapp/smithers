# claude-mirror

Durable-store backends for the `smithers claude ...` protocol commands the
Claude Code plugin consumes:

- `buildClaudeMirrorTick.js` — one complete /workflows mirror frame.
- `buildClaudeNodeWait.js` — block until one node is terminal, or report that
  it vanished from the plan.
- `waitForClaudeMirrorChange.js` — block until a mirror-relevant event lands.
- `runClaudeMonitor.js` — NDJSON follower of notable transitions across runs.

Contract: `claudeMirrorContract.js` is the wire-format major version pinned by
the plugin's mirror script; bump it only on breaking response-shape changes.
`claudeMirrorRelevantEventTypes.js` filters event chatter so a blocking
`--wait` does not wake per tool call.

Layout: one export per file. The four entry modules are imported only by
`src/index.js` (plus the claude-mirror tests for `runClaudeMonitor`); the
`extract*`/`isTerminal*`/`truncate*` modules are shared internals. Small local
helpers (`sleep`, `parsePayload`, `approvalTitle`) are deliberately duplicated
per command module so each stays self-contained.

Gotchas: adapter `*Effect` methods return `RunnableEffect` values, which are
PromiseLike, so `await Promise.resolve(adapter.xxxEffect(...))` is valid; node
ids use `@@` as the logical-id/iteration separator when collapsing loop
iterations.
