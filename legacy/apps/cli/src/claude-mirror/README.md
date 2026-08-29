# claude-mirror

Durable-store backends for the `smithers claude ...` protocol commands the
Claude Code plugin consumes:

- `buildClaudeMirrorTick.js` — one complete /workflows mirror frame.
- `buildClaudeNodeWait.js` — block until one node is terminal, or report that
  it vanished from the plan.
- `waitForClaudeMirrorChange.js` — block until a mirror-relevant event lands.
- `runClaudeMonitor.js` — NDJSON follower of notable transitions across the
  runs the session subscribed to (all runs only with `subscriptionsPath`
  unset / `--all-runs`). Also breaks silence on its own: `node-retrying`
  fires when an active attempt reaches the churn threshold, and
  `run-progress` fires whenever a followed non-terminal run has written no
  line for a full window, so an alive-but-churning detached run can never
  go unreported (#1413).

Subscriptions: the workspace store is shared by every session, so the monitor
follows only the runs its session subscribed to. The registry lives at
`.smithers/claude-mirror-subscriptions.json` (see
`resolveClaudeMirrorSubscriptionsPath.js`), entries keyed by
(runId, sessionId) with a 24h TTL. `claude tick` upserts on every frame
(following a run IS subscribing), launch paths call
`subscribeClaudeSessionRun.js` when `CLAUDE_CODE_SESSION_ID` is set, `claude
subscribe`/`unsubscribe` are the explicit path, and the monitor prunes runs
that turn terminal. Registry helpers (`readClaudeMirrorSubscriptions.js`,
`upsertClaudeMirrorSubscription.js`, `removeClaudeMirrorSubscription.js`)
never throw: a corrupt or missing registry degrades to silence, and writes
are atomic temp+rename with last-write-wins (the next tick re-asserts a lost
upsert).

Contract: `claudeMirrorContract.js` is the wire-format major version pinned by
the plugin's mirror script; bump it only on breaking response-shape changes.
`claudeMirrorRelevantEventTypes.js` filters event chatter so a blocking
`--wait` does not wake per tool call.

Layout: one export per file. The entry modules are imported only by
`src/index.js` and `src/mcp/semantic-tools.js` (plus the claude-mirror tests);
the `extract*`/`isTerminal*`/`truncate*` modules are shared internals. Small local
helpers (`sleep`, `parsePayload`, `approvalTitle`) are deliberately duplicated
per command module so each stays self-contained.

Gotchas: adapter `*Effect` methods return `RunnableEffect` values, which are
PromiseLike, so `await Promise.resolve(adapter.xxxEffect(...))` is valid; node
ids use `@@` as the logical-id/iteration separator when collapsing loop
iterations.
