# Smithers — full-codebase bug review

Multi-agent adversarial review of all product source (`packages/*/src`, `apps/*/src`, `scripts/`): 1,597 files / ~139K LOC, 252 review units + 10 cross-file deep dives. Every finding was independently re-verified against the real code by a skeptic agent; only confirmed defects are listed. Near-duplicate confirmations were clustered (a bug flagged by N agents shows "corroborated ×N").

**Confirmed real bugs: 270** (after clustering ) — critical 0, high 21, medium 124, low 125

## By area

| Area | high | medium | low | total |
|---|--:|--:|--:|--:|
| `apps/cli` | 5 | 21 | 33 | 59 |
| `packages/server` | 2 | 14 | 19 | 35 |
| `packages/agents` | 1 | 17 | 11 | 29 |
| `packages/engine` | 2 | 9 | 14 | 25 |
| `packages/smithers` | 0 | 8 | 5 | 13 |
| `apps/review` | 3 | 6 | 3 | 12 |
| `packages/db` | 1 | 5 | 4 | 10 |
| `packages/time-travel` | 1 | 6 | 3 | 10 |
| `packages/components` | 0 | 8 | 2 | 10 |
| `packages/pi-plugin` | 1 | 3 | 5 | 9 |
| `packages/sandbox` | 1 | 6 | 2 | 9 |
| `apps/observability` | 1 | 2 | 4 | 7 |
| `packages/driver` | 1 | 3 | 1 | 5 |
| `packages/electric-proxy` | 0 | 1 | 4 | 5 |
| `packages/openapi` | 0 | 3 | 2 | 5 |
| `scripts` | 0 | 2 | 3 | 5 |
| `packages/gateway-react` | 0 | 1 | 3 | 4 |
| `packages/scheduler` | 1 | 2 | 0 | 3 |
| `packages/gateway-client` | 0 | 3 | 0 | 3 |
| `packages/accounts` | 0 | 1 | 1 | 2 |
| `packages/control-plane` | 0 | 1 | 1 | 2 |
| `packages/usage` | 0 | 1 | 1 | 2 |
| `packages/errors` | 1 | 0 | 0 | 1 |
| `packages/devtools` | 0 | 1 | 0 | 1 |
| `packages/graph` | 0 | 0 | 1 | 1 |
| `packages/react-reconciler` | 0 | 0 | 1 | 1 |
| `packages/scorers` | 0 | 0 | 1 | 1 |
| `packages/vcs` | 0 | 0 | 1 | 1 |

## HIGH (21)

### 1. [HIGH · security] `apps/cli/src/index.js:2089`  _(corroborated ×4)_

**`up --serve` binds an unauthenticated full-control HTTP server to any host with no loopback/insecure gate**

In the serve branch of executeUpCommand, the server is started with `Bun.serve({ port: options.port, hostname: options.host, fetch: serveApp.fetch })` (lines 2089-2093). `options.host` defaults to 127.0.0.1 but accepts any value with NO guard. The serve app (packages/server/src/serve.js) only installs auth middleware `if (authToken)` (line 120) — and authToken here is `options.authToken ?? process.env.SMITHERS_API_KEY`, which can be undefined. That same app exposes mutating control-plane endpoints `POST /approve/:nodeId`, `POST /deny/:nodeId`, and `POST /cancel` (serve.js:219-233). So `smithers up wf.tsx --serve --host 0.0.0.0` with no token and no SMITHERS_API_KEY publishes an unauthenticated, full-control endpoint (approve/deny/cancel runs) to the network. The sibling `gateway` command (lines 2316-2320) explicitly refuses this: `if (!isLoopback && !authToken && !options.insecure) throw GATEWAY_INSECURE_BIND`. `up --serve` lacks that gate entirely, and even lacks an `insecure` flag, so the hardening applied to `gateway` was never applied here. The detach path propagates the same exposure (line 1916 forwards a non-loopback --host to the background child).

**Fix:** Before `Bun.serve(...)` in the serve branch, apply the same guard used by runGatewayCommand: compute `const authToken = options.authToken ?? process.env.SMITHERS_API_KEY` and if the host is not in GATEWAY_LOOPBACK_HOSTS and there is no authToken, fail with an INSECURE_BIND error (add an `--insecure` opt-out to upOptions to match gateway).

*Verifier:* Confirmed. up --serve path (index.js:2083-2095) calls Bun.serve with hostname: options.host and authToken: options.authToken ?? process.env.SMITHERS_API_KEY (can be undefined). serve.js:120 only installs auth middleware `if (authToken)`, and serve.js:219-233 expose POST /approve/:nodeId, /deny/:nodeId, /cancel. options.host (default 127.0.0.1) accepts any value with NO loopback/auth guard, unlike runGatewayCommand which throws GATEWAY_INSECURE_BIND at index.js:2320. Detach path forwards a non-loopback --host (index.js:1918). So `up --serve --host 0.0.0.0` with no token publishes an unauthenticated full-control endpoint.

### 2. [HIGH · logic] `apps/cli/src/index.js:5379`  _(corroborated ×3)_

**approve/deny ignore the pending approval's iteration, breaking gates inside loops**

In `approve` (and identically `deny`), when the node is auto-detected the code takes the node id from the pending approval but the iteration from the option, which defaults to 0:

```js
if (!nodeId) { ... nodeId = pending[0].nodeId; }
await Effect.runPromise(approveNode(adapter, c.args.runId, nodeId, c.options.iteration, ...));
```

`approveOptions.iteration` is `z.number().int().min(0).default(0)`, so when the user runs `smithers approve <runId>` (or even `--node <id>`) without `--iteration`, iteration is always 0. But `approveNode` resolves the approval/node by the exact `(runId, nodeId, iteration)` tuple and then calls `validateNodeWaitingForApproval` on `getNode(runId, nodeId, 0)` (packages/engine/src/approvals.js:71-73). For any loop/Ralph workflow that pauses for approval at iteration > 0, `pending[0].iteration` is e.g. 3, so the lookup at iteration 0 returns no waiting node and `approveNode` fails with INVALID_INPUT 'Node X is not waiting for approval.' The single pending gate can never be approved/denied from the CLI, so the human-in-the-loop run stays stuck. The command even advertises 'Auto-detects the pending node if only one exists', but it does not auto-detect that node's iteration.

**Fix:** When auto-detecting (and generally), use the pending approval's iteration: resolve `const target = c.options.node ? pending.find(a => a.nodeId === c.options.node) : pending[0];` then call `approveNode(adapter, runId, target.nodeId, c.options.iteration ?? target.iteration, ...)`. Make `iteration` `.optional()` (no default 0) so an unspecified iteration falls back to the pending gate's actual iteration. Apply the same fix to the `deny` command at line 5516.

*Verifier:* Same confirmed bug as [14]/[15], stated as the combined approve/deny iteration defect. Both commands take nodeId from pending[0] but iteration from the default-0 option (index.js:5379/5381 and 5516/5518; approveOptions.iteration default 0 at 1599). approveNode/denyNode resolve by the exact (runId,nodeId,iteration) tuple and validateNodeWaitingForApproval at iteration 0 (approvals.js:71-73), so a single pending gate at iteration>0 fails INVALID_INPUT and can never be approved/denied from the CLI without manually supplying --iteration, despite advertising auto-detection.

### 3. [HIGH · logic] `apps/cli/src/mcp/semantic-tools.js:1121`

**watch_run treats waiting-quota runs as terminal, stops polling prematurely**

In the `watch_run` handler the terminal-state test only excludes four waiting statuses:

```js
if (run.status !== "running" &&
    run.status !== "waiting-approval" &&
    run.status !== "waiting-event" &&
    run.status !== "waiting-timer") {
    return { ...reachedTerminal: true, timedOut: false, finalRun: summary, snapshots };
}
```

But `waiting-quota` is a real run-level waiting status, not a terminal one. It is in the DB allow-list (packages/db/src/adapter/DB_RUN_ALLOWED_STATUSES.js: `"waiting-quota"`), the RunState union (packages/db/src/runState/RunState.ts), and is written by the engine via `markRunWaiting("waiting-quota", "quota", ...)` (packages/engine/src/engine.js:5183) when an agent hits a provider quota/rate limit (e.g. the Claude 5-hour limit) and the run will resume once quota resets. Because this status is not in the exclusion list, `watch_run` classifies a quota-paused run as terminal: it returns `reachedTerminal: true` and stops polling. An orchestrating agent watching the run will believe it finished while it is actually just waiting to resume, and will act on a wrong, non-final `finalRun` snapshot. The engine's own `isWaitingStatus` (packages/engine/src/effect/workflow-make-bridge.js:62) correctly includes `waiting-quota`, confirming it is meant to be non-terminal.

**Fix:** Add `&& run.status !== "waiting-quota"` to the terminal check (and consider deriving the waiting set from a single shared constant so it cannot drift).

*Verifier:* Confirmed. watch_run's terminal test (lines 1121-1124) excludes only running, waiting-approval, waiting-event, waiting-timer. `waiting-quota` is a real non-terminal run status: it is in DB_RUN_ALLOWED_STATUSES.js, is written at run level by markRunWaiting('waiting-quota','quota',...) (engine.js:5183, signature at 5018-5023), and the engine's own isWaitingStatus (workflow-make-bridge.js:62) classifies it as waiting/non-terminal. Because watch_run omits it, a quota-paused run (e.g. Claude 5h limit) is treated as terminal: returns reachedTerminal:true, stops polling, and reports a non-final finalRun summary. An orchestrating agent will wrongly believe the run finished. Genuine logic bug.

### 4. [HIGH · logic] `apps/cli/src/workflow-pack.js:1941`

**Kanban UI: collectStreamEvents discards the event name, so deriveTickets never advances any ticket**

In the generated `.smithers/ui/kanban.tsx`, `collectStreamEvents` (workflow-pack.js:1939-1943) does `events.map((frame) => (isRecord(frame.payload) ? frame.payload : frame))`. `stream.events` comes from `useGatewayRunEvents`, whose `toFrame` returns frames of shape `{ type, event: <name>, payload: <eventPayload>, seq, stateVersion }` (packages/gateway-react/src/useGatewayRunEvents.ts:13-15). For every node event the gateway emits `{ event: "node.started", payload: { runId, nodeId, state } }` (confirmed in packages/server/tests/mapEvent.test.js:30-46), so `frame.payload` is ALWAYS a record and the map unconditionally unwraps the frame down to just its payload `{ runId, nodeId, state }`, throwing away the `event` name. `deriveTickets` then reads `const eventName = asString(event.event)` (workflow-pack.js:1959) and immediately `continue`s when it is not one of node.started/finished/failed (line 1960). After unwrapping there is no `.event` field on the object, so `eventName` is always `undefined` and EVERY event is skipped. Net effect: discovered tickets are seeded into the "pending"/"Backlog" lane and never transition to in-progress/completed/failed, and the per-ticket `{t.events} Events` counter stays 0, no matter how far the run actually progresses. The two consumers of `streamEvents` even disagree on the shape: the `.filter((event) => asString(event.runId) === activeRunId)` at line 2013 only works because of the unwrap (it reads `payload.runId`), while `deriveTickets` was written for the un-unwrapped `{event, payload}` frame. The Kanban board is effectively static.

**Fix:** Stop unwrapping in collectStreamEvents: return the frames as-is (`{ event, payload }`), and change the streamEvents runId filter to read the nested payload, e.g. `.filter((frame) => !activeRunId || asString((isRecord(frame.payload) ? frame.payload : {}).runId) === activeRunId)`. Then deriveTickets' `event.event` / `event.payload.nodeId` reads will be correct. Regenerate the init pack (`pnpm generate:init-pack`) so the committed `.smithers/ui/kanban.tsx` matches.

*Verifier:* Confirmed. useGatewayRunEvents.ts toFrame (line 13-15) returns {type, event: row.event, payload: row.payload, seq, stateVersion}. collectStreamEvents (workflow-pack.js:1939-1942) maps each frame to frame.payload when payload is a record. Node events always have a record payload {runId,nodeId,state}, so the event NAME is discarded. deriveTickets (1958-1960) then reads event.event (now undefined) and continues on every event, so no ticket ever transitions out of 'pending' and the event counters stay 0. The line 2013 filter reading event.runId only works BECAUSE of the unwrap, confirming the two consumers disagree on shape. Kanban board is effectively static.

### 5. [HIGH · correctness] `apps/cli/src/workflow-pack.js:4311`

**Kanban buildFeedback mixes reviews across all tickets (cross-ticket convergence contamination)**

In the generated kanban.tsx template, buildFeedback claims to scope reviews to the current ticket but doesn't. It reads ALL review rows for the whole run and filters only by reviewer name:

  const reviews = ctx.outputs.review ?? [];
  // Filter reviews for this ticket's prefix
  const ticketReviews = reviews.filter((r) => r.reviewer?.startsWith?.("reviewer-"));

I confirmed in packages/driver/src/SmithersCtx.js that ctx.outputs.<name> returns every row for that output table across the entire run (all tickets, all loop iterations), and in packages/driver/src/WorkflowDriver.js (snapshotFromContext) that each row is the decoded output spread with `nodeId` and `iteration`. The Review component (workflow-pack.js ~line 1103) always sets reviewer = `reviewer-${index+1}` (reviewer-1, reviewer-2), with no ticket identifier. So the predicate `r.reviewer?.startsWith?.("reviewer-")` matches reviews from EVERY ticket running in the Parallel block. The `slug` parameter is used to scope `validate` (nodeId `${slug}:validate`) but is never used to scope reviews.

Consequence in a multi-ticket parallel kanban run: `anyReviewApproved = ticketReviews.length > 0 && ticketReviews.some((r) => r.approved === true)` becomes true for ticket A if ANY reviewer of ANY other ticket approved. Combined with A's own validation passing, `done` flips true prematurely, so A's worktree work is committed and handed to the merge step even though A's own reviewers may have rejected it (shipping unreviewed work). Conversely, A's loop can keep iterating because another ticket's reviewer rejected. Feedback strings also splice in other tickets' rejection messages.

**Fix:** Scope reviews by the ticket's review node id, e.g. `const ticketReviews = reviews.filter((r) => typeof r.nodeId === "string" && r.nodeId.startsWith(`${slug}:review`));` (the rows carry nodeId). Drop the reviewer-prefix predicate.

*Verifier:* Confirmed. buildFeedback (4302-4344) reads reviews = ctx.outputs.review (all review rows for the whole run, across all parallel tickets) and filters ONLY by r.reviewer?.startsWith('reviewer-'). The Review component (1103) always sets reviewer=`reviewer-${index+1}` with no ticket identifier, so the predicate matches every ticket's reviews. validate is correctly scoped via nodeId `${slug}:validate` (4307) but reviews are not. anyReviewApproved -> done (4318-4319) thus flips true for ticket A when any other ticket's reviewer approved, and done gates the commit (4401). Cross-ticket convergence contamination: can commit/ship A's unreviewed work or block A on another ticket's rejection. Serious logic bug.

### 6. [HIGH · correctness] `apps/observability/src/renderPrometheusMetrics.js:163`  _(corroborated ×2)_

**Histogram +Inf bucket emitted twice (le="Infinity" and le="+Inf"), producing malformed Prometheus output**

Effect histogram boundaries always include `Infinity` as the final bucket boundary. Both the live render path and the default/zero path stringify that boundary directly and ALSO append an explicit `+Inf` line, so every histogram series gets two terminal buckets.

Live path (line 162-165):
```
for (const bucket of histogramBuckets(metricState)) {
    metric.lines.push(`${name}_bucket${mergePrometheusLabels(labels, [["le", String(bucket.boundary)]])} ...`);
}
metric.lines.push(`${name}_bucket${mergePrometheusLabels(labels, [["le", "+Inf"]])} ...`);
```
I verified Effect's histogram snapshot `metricState.buckets` ends with `[Infinity, count]` (e.g. `[[100,0],[200,1],[400,1],[Infinity,1]]`). `String(Infinity)` is `"Infinity"`, so the loop emits `..._bucket{le="Infinity"} N` and then the explicit line emits `..._bucket{le="+Inf"} N`.

Same in the default/zero path (line 103-108): `definition.boundaries` for every histogram fed by `metricBoundaryValues` (durationBuckets/fastBuckets/toolBuckets/tokenBuckets/sizeBuckets/etc., and even `contextWindowBuckets`) includes `Infinity` (confirmed: `[...,102400,Infinity]`), so line 107 emits `le="Infinity"` and line 108 emits `le="+Inf"`.

Impact: Prometheus's float parser (Go strconv.ParseFloat) reads "Infinity" as +Inf, so each histogram exposes two `le="+Inf"` buckets with identical values. That is a duplicate-bucket / duplicate-series condition that Prometheus rejects or silently mis-ingests, corrupting every histogram in this observability product's scrape output. Note the four histograms that use `metricHistogramBoundaries` (snapshotDuration, scorerDuration, openApiToolDuration, memoryRecallDuration) avoid the bad DEFAULT line because that helper filters with `Number.isFinite`, but they are still broken in the LIVE path.

**Fix:** Skip non-finite boundaries before emitting bucket lines. In the live loop, guard `if (!Number.isFinite(bucket.boundary)) continue;` (or filter in `histogramBuckets`), and in `defaultPrometheusMetricLines` filter `boundaries.filter(Number.isFinite)` before mapping. Also make `metricBoundaryValues` in smithersMetricCatalog.js filter `Number.isFinite` to match `metricHistogramBoundaries`, so `definition.boundaries` never contains Infinity.

*Verifier:* Confirmed and more precise than [0]. Live path (lines 164-167) emits le="Infinity" (String(Infinity)) then le="+Inf" for every histogram. Default/zero path (lines 103-108) uses definition.boundaries from metricBoundaryValues (smithersMetricCatalog.js:141) which only sorts and does NOT filter Infinity, so it also emits le="Infinity" then le="+Inf" for all durationBucketValues/fastBucketValues/etc-based metrics. The 4 metrics using metricHistogramBoundaries (lines 491-494) filter Infinity via Number.isFinite so they escape the default bad line but are still broken in the live path. Duplicate +Inf buckets corrupt Prometheus ingestion. Severity raised from medium to high given it breaks the core output of an observability product.

### 7. [HIGH · security] `apps/review/action/src/runAction.ts:90`

**Codex/ChatGPT credential written inside the workspace the review agents traverse**

In codex-subscription mode the action materializes the repo owner's ChatGPT OAuth credential into `const codexHome = process.env.CODEX_HOME?.trim() || join(workspace, ".smithers-codex-home")` and `writeFileSync(join(codexHome, "auth.json"), process.env.CODEX_AUTH_JSON ?? "", { mode: 0o600 })`. `workspace` is `GITHUB_WORKSPACE` — the checked-out PR repo — and the review subprocess passes that same directory to the review CLI as its positional repo argument, so the codex review/narrator agents operate with their file-read scope rooted there. The secret `auth.json` therefore lives *inside* the tree the agents (and prompt-injected PR content) can read. A malicious PR diff that says "print the contents of .smithers-codex-home/auth.json" can exfiltrate the ChatGPT subscription credential into the agent output and then into the published walkthrough. Secrets must not be written inside the directory the untrusted-PR-reviewing agents can read.

**Fix:** Default CODEX_HOME to a path outside the workspace, e.g. join(process.env.RUNNER_TEMP ?? os.tmpdir(), ".smithers-codex-home"), so the credential is never inside the repo tree the agents traverse.

*Verifier:* Confirmed in runAction.ts lines 90-93: when inference.mode === 'codex-subscription' and CODEX_HOME is unset (action.yml never sets it), codexHome defaults to join(workspace, '.smithers-codex-home') and writeFileSync(join(codexHome,'auth.json'), CODEX_AUTH_JSON, {mode:0o600}) drops the ChatGPT OAuth credential there. workspace = GITHUB_WORKSPACE (the checked-out PR repo, populated by the actions/checkout step that runs before runAction). runReview.ts line 27 passes that same workspace as the CLI's positional repo argument, so the codex review/narrator agents traverse a tree that now contains the secret at .smithers-codex-home/auth.json. mode 0o600 only blocks other OS users, not the same-user agent process. This is a genuine secret-placement weakness: a prompt-injected PR diff could ask the agent to read and echo that file into the published walkthrough, leaking the repo's subscription credential. The fix is to write the credential outside the reviewed tree (e.g. RUNNER_TEMP). Severity high but gated behind successful prompt injection, hence medium confidence on exploitability.

### 8. [HIGH · correctness] `apps/review/src/server/metrics/handleMetrics.ts:70`

**Token metrics emit duplicate Prometheus series, breaking the entire scrape**

The tokens query groups by three columns: `SELECT repo, model, kind, SUM(input_tokens)... FROM usage_events GROUP BY repo, model, kind` (line 50). But the output loop emits labels that DROP the row's `kind` and hardcode a literal direction label instead:

```
const labels = `repo="${escapeLabel(row.repo)}",model="${escapeLabel(row.model)}",kind="input"`;
lines.push(`review_tokens_total{${labels}} ${row.input_tokens ?? 0}`);
const labelsO = `repo="${escapeLabel(row.repo)}",model="${escapeLabel(row.model)}",kind="output"`;
lines.push(`review_tokens_total{${labelsO}} ${row.output_tokens ?? 0}`);
```

The DB `kind` column is one of `"messages" | "messages_stream" | "other"` (see src/server/proxy/recordUsage.ts:23). So a repo+model that has handled BOTH a non-streaming request (kind='messages') and a streaming request (kind='messages_stream') — the normal case in production — produces two grouped rows. Both rows are emitted with the EXACT SAME label set `repo=...,model=...,kind="input"` (and again for kind="output"), differing only in value. That is a duplicate time series within a single exposition.

Prometheus rejects an exposition that contains duplicate series for the same metric name + label set; the whole scrape fails ('duplicate sample for timestamp' / collected-before error), so the target is marked down and ALL metrics from /metrics (spend, prs, quota) are lost, not just tokens. It also undercounts because the two rows aren't summed. The existing test only seeds a single kind='messages' row, so it never exercises the collision.

**Fix:** Either drop `kind` from the GROUP BY so each repo+model collapses to one row (`SELECT repo, model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens FROM usage_events GROUP BY repo, model`), since the row's kind is never used in output anyway; or, if per-kind breakdown is wanted, include `row.kind` in the label under a distinct label name (e.g. `op="${escapeLabel(row.kind)}"`) alongside the input/output direction label so the label sets stay unique.

*Verifier:* Line 50 groups by repo, model, kind. Lines 71-74 emit labels that hardcode kind="input"/kind="output" and ignore row.kind. recordUsage.ts:23 and handleAnthropic.ts:140 confirm kind takes values messages/messages_stream/other and both messages and messages_stream are recorded in normal operation. A repo+model with two distinct DB kinds therefore produces two grouped rows emitted with the exact same Prometheus label set (repo,model,kind="input") differing only in value = duplicate series in one exposition, which Prometheus rejects (whole scrape fails, all /metrics series lost), plus the kinds are not summed so it undercounts. The existing test seeds a single kind so the collision is never exercised. Genuine defect.

### 9. [HIGH · correctness] `apps/review/src/server/proxy/parseUsageFromJson.ts:15`

**Usage parsing ignores cache tokens, undercounting real spend and defeating the runaway brake**

Both parsers only read `usage.input_tokens` and `usage.output_tokens`. Anthropic's Messages usage object also returns `cache_creation_input_tokens` and `cache_read_input_tokens`, which are billed (cache reads ~0.1x, cache creation ~1.25x) and are NOT included in `input_tokens` (which is only the uncached prompt portion). In parseUsageFromJson: `const input = obj.usage?.input_tokens ?? 0;` and in parseUsageFromSse lines 39-46 the same fields are dropped. recordUsage then computes cost from these undercounted token counts (recordUsage.ts:28-30). For a code-review agent that uses prompt caching heavily, the cached tokens can dwarf `input_tokens`, so the metered cost and the session `spent_usd` tally are far below what Anthropic actually charges. The whole stated purpose of this code is 'the per-session runaway brake' (modelPrices.ts:2-3) - by ignoring cache tokens the 402 cap (handleAnthropic.ts:89) fires far later than the real invoice, allowing substantial spend overrun on every cached session, and dashboards systematically undercount cost.

**Fix:** Parse `cache_creation_input_tokens` and `cache_read_input_tokens` from usage in both parseUsageFromJson and parseUsageFromSse, extend UsageSummary/ModelPrice with cache-write and cache-read prices, and include them in the costUsd computation in recordUsage.

*Verifier:* Confirmed in the real code. parseUsageFromJson.ts:11-16 and parseUsageFromSse.ts:37-49 read only usage.input_tokens and usage.output_tokens; UsageSummary (parseUsage.ts) has no cache fields and modelPrices.ts has no cache price columns. recordUsage.ts:27-30 derives costUsd only from inputTokens*price.input + outputTokens*price.output and increments sessions.spent_usd, which handleAnthropic.ts:88-90 uses for the 402 cap. Anthropic's usage object reports cache_creation_input_tokens and cache_read_input_tokens separately from input_tokens (which is only the uncached prompt portion), and both are billed. So cached tokens are entirely dropped from the cost computation, undercounting spend and making the per-session runaway brake fire later than the real invoice. This is a real correctness/billing defect; severity high but not critical since it degrades accuracy of metering/cap rather than crashing or leaking data, and magnitude scales with how much caching the traffic uses.

### 10. [HIGH · crash] `packages/agents/src/BaseCliAgent/runRpcCommandEffect.js:355`

**Writes to child.stdin have no 'error' listener; EPIPE crashes the whole process**

The child is spawned with no error handler attached to its stdin stream, yet `child.stdin.write(...)` is called at line 355 (prompt payload) and line 218 (extension UI response). The only guard is `if (!child.stdin)`. If the spawned CLI exits or fails to start between spawn and the write, writing to an already-closed pipe emits an asynchronous 'error' (EPIPE/ECONNRESET) on the stdin writable stream. With no `child.stdin.on('error', ...)` listener anywhere in the file, Node turns that into an uncaught exception that tears down the entire orchestrator process, not just this one agent run. This is reachable in normal operation: a fast-exiting agent, an agent that closes stdin early, or the abort-before-write path below. `child.on('error')` (line 318) only handles spawn errors, not stdin stream errors.

**Fix:** Attach `child.stdin.on('error', () => {})` (or route to handleError) right after spawn, and pass a write callback to swallow/handle the error, e.g. `child.stdin.write(payload, () => {})`. Guard the writes with a settled check.

*Verifier:* Lines 218 and 355 call child.stdin.write(...) guarded only by `if (!child.stdin)` (213, 351). grep confirms no `child.stdin.on('error', ...)` listener exists in the file; child.on('error') (318) handles only spawn errors, not writable-stream errors. Writing to a pipe whose reader has closed (fast-exiting/early-closing agent, or the abort path) emits an async 'error' (EPIPE) on the Writable; with no listener Node escalates to uncaughtException, crashing the whole orchestrator process. The child is spawned detached/unref'd, making early independent exit realistic. Genuine crash vector.

### 11. [HIGH · concurrency] `packages/db/src/adapter.js:766`  _(corroborated ×2)_

**Interruption during acquireTransactionTurn permanently deadlocks all DB ops on the client**

`acquireTransactionTurn` advances the shared serialization queue BEFORE the release handle is handed to the caller:
```
const gate = new Promise((resolve) => { release = resolve; });
const previous = state.tail.catch(() => undefined);
state.tail = previous.then(() => gate);   // tail now blocks on `gate`
this.transactionTail = state.tail;
await previous;                            // suspend point
return release;
```
The release callback (`release`) is only RETURNED to the caller on success; the caller (`read`/`write`/`withTransactionEffect`) is what installs the `Effect.ensuring(() => releaseTurn())` finalizer that resolves `gate`. `acquireTransactionTurn` is built with `Effect.tryPromise` (interruptible by default) and is yielded directly in every caller (lines 707, 740, 804, …) with no `uninterruptibleMask`/`acquireRelease` protection. If the fiber is interrupted while suspended on `await previous` (run cancellation via `smithers cancel`/`down`, a timeout, or a losing `Effect.race` branch), Effect abandons the await and never returns `release`, so the finalizer is never wired up and `gate` never resolves. But `state.tail` has already been reassigned to `previous.then(() => gate)`, a promise that now never settles. Every subsequent `acquireTransactionTurn` does `state.tail.catch(...)` then `await previous`, which hangs forever (`.catch` only handles rejection, not a perpetually-pending promise). Result: one mistimed cancellation poisons the per-client transaction queue and deadlocks ALL future reads/writes/transactions for that SQLite/Postgres connection for the life of the process. The state is held in a process-global WeakMap (sqliteTransactionStateByClient), so it is not isolated per adapter instance.

**Fix:** Make turn acquisition interruption-safe so the queue is never advanced unless a release is guaranteed. Either wrap the acquire/use/release as `Effect.acquireRelease(acquireTransactionTurn, (release) => Effect.sync(release))` (so the finalizer always fires), or inside `acquireTransactionTurn` use `Effect.uninterruptibleMask`/`onInterrupt` to call `release()` (resolve `gate`) if the fiber is interrupted before the handle is delivered. Only mutate `state.tail` after the await completes, or guarantee `gate` resolution on every exit path.

*Verifier:* Same defect as finding 0, described from the turn-queue angle and equally valid. acquireTransactionTurn (L766-785) advances `state.tail` synchronously then awaits the predecessor; the interruptible Effect.tryPromise has no uninterruptibleMask/acquireRelease (callers yield it directly at L707, L740, L804). Interruption during `await previous` abandons the promise, never returns `release`, leaving `state.tail` = `previous.then(() => gate)` permanently pending. `.catch` in the next acquisition only handles rejection, not a perpetually-pending promise, so all future read/write/transaction ops on that client deadlock. State held in the global WeakMap sqliteTransactionStateByClient. Confirmed mechanism; medium confidence on real-world interruption timing.

### 12. [HIGH · performance] `packages/driver/src/WorkflowDriver.js:592`

**CPU busy-spin when an elapsed absolute Timer coexists with an in-flight sibling task**

In `handleWait`, when other work is still in flight (`this.inflightTasks.size > 0`) and the wait reason is a `Timer`, the deadline is computed as `Math.max(0, reason.resumeAtMs - Date.now())` (line 593) and passed to `nextCompletionDecision(deadlineMs)`. For an absolute timer (a `<Timer until=...>`, whose `resumeAtMs` comes from `timerResumeAtMs` parsing `__timerUntil` to a fixed timestamp) that has already elapsed, `deadlineMs === 0`. `nextCompletionDecision(0)` then races the in-flight task promises against `sleepWithAbort(0)`, which resolves immediately (`if (ms <= 0) return;`). `this.settledTasks.shift()` returns undefined, so it re-submits `lastGraph` (WorkflowDriver.js:539-541). `decide()` re-evaluates: the timer task is still in `waiting-timer` (nothing fires it here — only `timerFired` does, and the driver short-circuits `onWait` while inflight>0 at line 586), so `findWaitingReason` returns the same elapsed `Timer` reason, the run loop calls `handleWait` again, deadline is again 0, and the cycle repeats with zero delay. This is a tight busy loop that pegs a CPU core for the entire remaining duration of the long in-flight sibling task (e.g. a parallel agent task running for minutes). Concrete trigger: `<Parallel>` containing a `<Timer until=<near-future>>` plus two tasks where one settles before the other; once `until` passes while the slow task is still running, the run spins. Note duration timers escape this (their `resumeAtMs` is recomputed to `now+ms` each pass, giving a positive deadline) so only absolute timers spin.

**Fix:** When `deadlineMs <= 0` for a Timer (the timer has already elapsed), do not loop on `nextCompletionDecision`; instead block purely on the in-flight task promises (treat as `null` deadline) so the spin can only resolve via a real completion, or fire the timer (`timerFired`) before re-deciding. Alternatively, only apply a Timer deadline when it is strictly in the future (`reason.resumeAtMs - Date.now() > 0 ? gap : null`).

*Verifier:* Confirmed CPU busy-spin. For an absolute timer, timerResumeAtMs (makeWorkflowSession.js lines 140-153) returns the FIXED parsed __timerUntil timestamp, so once elapsed resumeAtMs < now permanently. In handleWait line 593 the deadline is `Math.max(0, reason.resumeAtMs - Date.now())` = 0. nextCompletionDecision(0): sleepWithAbort(0) returns immediately (ms<=0 return), so the race resolves at once with no settled task; settledTasks.shift() is undefined (line 535-536) so it re-submits lastGraph (line 540). Critically, decide() does NOT auto-fire elapsed timers: on `task.meta?.__timer` it unconditionally sets state 'waiting-timer' and returns Wait{Timer, resumeAtMs} (lines 677-681); only the explicit timerFired method advances it, and the driver short-circuits onWait/timer-firing while inflightTasks.size>0 (line 586). So the loop returns the same elapsed Timer Wait → deadline 0 → immediate resubmit, with zero delay, pegging a core for the entire remaining duration of the slow in-flight sibling. Duration timers (__timerDuration) escape because timerResumeAtMs recomputes nowMs+ms each pass. High severity (CPU peg for minutes).

### 13. [HIGH · logic] `packages/engine/src/effect/builder.js:653`

**Unnamed builder loops stamp handles with "__loop__", which never matches the engine's iteration key, so all reads stay at iteration 0**

`annotateLoops` stamps loop-internal handles with `node.id ?? "__loop__"`:

```
case "loop": {
  ...
  const handles = annotateLoops(node.children, node.id ?? "__loop__");
```

and `resolveHandleIteration` looks the iteration up by that id:

```
if (handle.loopId) { return ctx.iterations?.[handle.loopId] ?? 0; }
```

For a NAMED loop, `node.id` (after `applyPrefixId`) is the same id passed to the `<Loop>` element, and the engine keys `ctx.iterations` by that id, so it matches. But for an UNNAMED loop (`loop({ children, until })` with no `id`), the `<Loop>` element gets `id=undefined`, and the engine's graph extractor resolves the ralph id via `resolveStableId(raw.id, "ralph", ctx.path)` -> `stablePathId("ralph", path)` (confirmed in packages/graph/src/extract.js), i.e. a path-derived id like `ralph-...`. That synthetic id is what becomes a key in `ctx.iterations`. The builder, however, stamped the handles with the literal string `"__loop__"`, which the engine never produces. So `ctx.iterations["__loop__"]` is always `undefined` -> `resolveHandleIteration` always returns 0. Consequently every handle read inside an unnamed loop (needs-dependency reads in `buildUserContext`, and the outputs gathered in `renderNode`'s loop branch for the `until` predicate) reads the iteration-0 row forever, never the current iteration's output. This breaks intra-loop data flow and makes `until` evaluate stale data, so an unnamed loop that should terminate based on the latest iteration's output never sees updated values and runs until `maxIterations`.

**Fix:** Stop using the magic string. Either require a loop id when handles inside need iteration-scoped reads, or derive the same stable id the engine uses (so annotateLoops stamps the resolved loop id rather than "__loop__"), or have resolveHandleIteration fall back to ctx.iteration (the engine's default loop iteration) when the loopId key is absent.

*Verifier:* annotateLoops (line 653) stamps unnamed-loop handles with loopId="__loop__". grep confirms "__loop__" exists ONLY at this line, never produced or consumed by the engine. The engine keys ctx.iterations by resolveStableId(raw.id,'ralph',path) (extract.js:386) -> path-derived 'ralph-...' id for an id-less Loop, plus scope suffixes; it is never '__loop__'. resolveHandleIteration (builder.js:328-330) returns ctx.iterations?.[handle.loopId] ?? 0 with NO ctx.iteration fallback. So every handle read inside an UNNAMED loop (until-predicate outputs at line 540 readHandleMaybe, and needs deps via readHandle in buildUserContext line 381) resolves to iteration 0 forever. Unnamed loops are explicitly supported (test line 131). Result: until evaluates stale iteration-0 data, intra-loop data flow is broken, and a loop that should terminate on a later iteration runs to maxIterations. Named loops match because handle.loopId==node.id==the explicit Loop id the engine keys on.

### 14. [HIGH · error-handling] `packages/engine/src/effect/workflow-make-bridge.js:212`

**Failed workflow throws the raw Effect Exit, erasing the real error code/message**

In `runWorkflowWithMakeBridge`, when the workflow body fails the code does:

```js
if (result._tag === "Complete") {
    if (Exit.isSuccess(result.exit)) {
        return result.exit.value;
    }
    throw result.exit;   // <-- throws an Exit, not the underlying error
}
```

`result.exit` is an Effect `Exit.Failure`, not an `Error`. The actual failure cause was captured earlier in `createWorkflowExecutionEffect` via `Effect.tryPromise({ ..., catch: (error) => error })`, so the original error (often a `SmithersError` carrying a specific `code` such as `AGENT_CONFIG_INVALID`, or a real task error message) is buried inside the Exit's cause. The caller `runWorkflow` in engine.js wraps the thrown value with `toSmithersError(cause, "run workflow")`. Because the thrown Exit is neither an `Error` nor a `SmithersError`, `toSmithersError` falls through to `causeSummary` → `String(cause)`, and assigns `code = "INTERNAL_ERROR"`.

I verified the runtime behavior with effect: `String(Exit.fail(new Error("body failed")))` yields a JSON blob `{"_id":"Exit","_tag":"Failure","cause":{"_id":"Cause","_tag":"Fail","failure":{}}}` — the Error serializes to an empty `{}`, so the message "body failed" is entirely lost, `instanceof Error` is false, and `.message` is undefined.

Concrete impact: every non-retryable workflow failure surfaces as a generic `INTERNAL_ERROR` with a useless `run workflow: {...}` summary instead of the real failure message/code. Any downstream code that branches on `error.code` (e.g. distinguishing AGENT_CONFIG_INVALID, quota, validation errors) will misbehave, and operators lose the actual cause when debugging failed runs.

**Fix:** Unwrap the failure before throwing, e.g. `import { Cause } from "effect"` and `throw Cause.squash(result.exit.cause)` (or extract the `Fail` value) so the original Error/SmithersError propagates with its code and message intact.

*Verifier:* Verified: Workflow.intoResult yields Complete({exit: Exit.failCause(cause)}) (@effect/workflow Workflow.js:215), so `throw result.exit` (line 212) throws an Effect Exit, not an Error. Caller chain runWorkflow (engine.js:6013-6020) wraps the rejection with toSmithersError(cause, 'run workflow'); no intermediate unwrap. Ran the real toSmithersError: an Exit is not instanceof Error nor SmithersError, fromTaggedError hits default for _tag 'Failure', so code becomes 'INTERNAL_ERROR' and message becomes a serialized JSON blob — original code (e.g. AGENT_CONFIG_INVALID) and message lost. Code-based error branching breaks. Note the 'every failure' framing is overstated: normal failed runs return a status and take the line 114-116 path; this path triggers only when an exception escapes the body. Defect is real and worth high for error-handling/debuggability.

### 15. [HIGH · error-handling] `packages/errors/src/SmithersError.js:36`

**SmithersError constructor misclassifies an Error passed as positional cause, dropping the real error from the cause chain**

The constructor distinguishes a positional `cause` argument from an `options` object with:

```js
const isOptionsObject = causeOrOptions &&
    typeof causeOrOptions === "object" &&
    (Object.prototype.hasOwnProperty.call(causeOrOptions, "cause") ||
        Object.prototype.hasOwnProperty.call(causeOrOptions, "includeDocsUrl") ||
        Object.prototype.hasOwnProperty.call(causeOrOptions, "name"));
const options = isOptionsObject ? causeOrOptions : { cause: causeOrOptions };
```

This heuristic conflates real `Error` instances with options objects. Two common error shapes have own `cause`/`name` data properties:
- Every `SmithersError` sets `this.name = ...` as an own property, so `hasOwnProperty(err, "name")` is true.
- Any `new Error(msg, { cause })` sets `cause` as an own property, so `hasOwnProperty(err, "cause")` is true.

When such an error is passed as the documented 4th positional cause argument, it is treated as `options`. The wrapper then takes `options.cause` (the inner error's cause, often undefined) and `options.name`, so the ACTUAL error is discarded from the chain and a wrong/empty cause and inherited name are stored instead.

Reproduced (run against the real file):
```
const inner = new SmithersError('INVALID_INPUT', 'the real failure', {a:1});
const wrapped = new SmithersError('SESSION_ERROR', 'Task failed', {key}, inner);
// wrapped.cause === inner  => false   (the failure is lost)
const e = new Error('boom', { cause: 'deep' });
const w2 = new SmithersError('SESSION_ERROR', 'x', undefined, e);
// w2.cause === e => false; w2.cause === 'deep'  (wrong cause)
```

This fires in production at packages/scheduler/src/makeWorkflowSession.js:585: `new SmithersError("SESSION_ERROR", ..., { key }, state.failures.get(key))` where `state.failures.get(key)` is a SmithersError (set at line 885). The underlying task-failure error is silently dropped from the durable SESSION_ERROR record that errorToJson serializes, corrupting the error chain used for debugging/inspection.

**Fix:** Do not infer options-vs-cause from own-property names that real Errors also carry. Treat any `Error` instance as a cause: `const isOptionsObject = causeOrOptions && typeof causeOrOptions === 'object' && !(causeOrOptions instanceof Error) && (hasOwnProperty 'cause' || 'includeDocsUrl' || 'name');`. Alternatively make callers always pass an explicit `{ cause }` object and document the positional cause form as unsupported.

*Verifier:* Confirmed by running the real file. The constructor's isOptionsObject heuristic (SmithersError.js:36-40) flags any object with an own `cause`, `includeDocsUrl`, or `name` property as an options object. SmithersError sets both `this.name` (line 48) and `this.cause` (line 53) as own properties, and `new Error(msg,{cause})` sets an own `cause`. So when such an error is passed as the 4th positional cause arg, it is misread as options: the code then uses options.cause (the inner error's cause, often undefined) and options.name instead of the error itself. Repro output: `new SmithersError('SESSION_ERROR','Task failed',{key},inner)` -> wrapped.cause === inner is false (real error dropped); `new Error('boom',{cause:'deep'})` passed positionally -> w2.cause === 'deep' (wrong cause). A plain `new Error('plain')` (no own name/cause) is handled correctly (w3.cause === p true), so the defect is specific to errors carrying own cause/name. The production call site packages/scheduler/src/makeWorkflowSession.js:585 passes `state.failures.get(key)`, which in the approval-timeout path (line 885) is a SmithersError, so the underlying failure is silently dropped from the durable SESSION_ERROR record. Real defect; corrupts the error/cause chain used for debugging and durable inspection.

### 16. [HIGH · error-handling] `packages/pi-plugin/src/extension.ts:123`  _(corroborated ×3)_

**Failed MCP connect permanently poisons mcpClient/mcpTransport with no recovery**

In `ensureMcpClient` the module globals are assigned BEFORE the await:
```
mcpTransport = new StdioClientTransport({...});
mcpClient = new Client({...});
await mcpClient.connect(mcpTransport);
```
If `connect` rejects (e.g. `bun` not yet on PATH, transient spawn failure, cli not built, slow startup), the exception propagates but `mcpClient` (and `mcpTransport`) remain assigned. The guard `if (mcpClient) return mcpClient;` at the top then short-circuits every subsequent call, returning the dead, never-connected client forever. Because `registerMcpToolsInner` swallows the error (try/catch -> notify warning) and `smithersToolContract` stays undefined, `ensureSmithersToolContract` keeps re-calling `ensureMcpClient`, which keeps returning the poisoned client. Every `callMcpTool`, every `smithers_*` tool, and `before_agent_start` (which awaits `ensureSmithersToolContract`) then fail for the entire session with no automatic recovery. A single transient startup failure disables all Smithers MCP tools until Pi is restarted.

**Fix:** Reset the globals on failure: wrap the connect in try/catch and on error set `mcpClient = undefined; mcpTransport = undefined;` (and ideally close the transport) before rethrowing, so a later call retries a fresh connection. Assign `mcpClient` to a local, await connect, then assign the module global only after a successful connect.

*Verifier:* Confirmed. In ensureMcpClient (lines 119-132) `mcpClient = new Client(...)` is assigned BEFORE `await mcpClient.connect(...)`. There is NO try/catch that resets it. Grepping the whole file, mcpClient is never set back to undefined anywhere. So if connect() rejects (bun not on PATH, transient spawn failure, slow start), mcpClient remains a non-connected instance, and the top guard `if (mcpClient) return mcpClient;` returns that dead client forever. registerMcpToolsInner (line 371) swallows the error into a warning notify, leaving smithersToolContract undefined, so ensureSmithersToolContract (line 134) keeps re-invoking ensureMcpClient, which keeps returning the poisoned client. callMcpTool and before_agent_start then fail for the whole session with no auto-recovery. Genuine defect.

### 17. [HIGH · error-handling] `packages/sandbox/src/execute.js:562`

**Failed/cancelled sandbox child workflow is reported as a successful node**

In both sandbox paths, after collecting and validating the result bundle the code records the manifest status and then returns its outputs unconditionally:

  // provider path (line 562)
  return validated.manifest.outputs;
  // non-provider path (line 740)
  return validated.manifest.outputs;

Nothing checks `validated.manifest.status`. The non-provider path even explicitly writes a failure status into the bundle (`status: child.status === "finished" ? "finished" : "failed"`, line 654) and then on collect/validate happily returns the (partial/empty) outputs, emitting `SandboxCompleted` with `status: validated.manifest.status` (lines 546-555 / 724-733). The compute function's return value IS the node's output and is the only signal back to the parent task, so a sandbox whose child workflow FAILED or was CANCELLED resolves the parent node as if it succeeded. Failures are silently swallowed: downstream nodes consume bogus/partial outputs and the run is treated as green. The diff-review gate only throws on patch count > 0, so a failed run that produced no patches returns cleanly.

**Fix:** After validation, if `validated.manifest.status` is "failed" or "cancelled", throw a SmithersError (e.g. SANDBOX_EXECUTION_FAILED) so the failure propagates to the parent node, instead of returning `validated.manifest.outputs`. Emit SandboxCompleted/SandboxFailed accordingly.

*Verifier:* Confirmed. executeChildWorkflow (packages/engine/src/child-workflow.js:139-162) returns {runId,status,output} and does NOT throw on a failed/cancelled child. The non-provider path writes status: child.status === 'finished' ? 'finished' : 'failed' (execute.js:654), validateSandboxBundle reads it back, then execute.js returns validated.manifest.outputs at line 562 (provider) and 740 (non-provider) with no check of validated.manifest.status. SandboxCompleted is emitted with the failure status but the function still resolves normally, so the compute node's return value (the only signal to the parent task) marks the node successful even when the child workflow FAILED/was CANCELLED. The diff-review gate only throws on totalPatchCount>0, so a failed run producing no patches returns cleanly. Genuine silent failure swallowing.

### 18. [HIGH · logic] `packages/scheduler/src/scheduleTasks.js:246`

**Ralph nested in Saga / TryCatchFinally is treated as instantly complete; loop body never runs**

The `inspect()` function (lines 129-249) drives terminal/failure determination for the action/try/catch/finally regions of `saga` and `try-catch-finally` nodes. Its switch handles `task`, `sequence`, `group`, `parallel`, `saga`, `try-catch-finally`, and a `default` that returns `{ terminal: true, failed: false }`. There is NO `case "ralph"` (nor `case "continue-as-new"`). So when a `<Ralph>` appears inside a Saga action or a TryCatchFinally try/catch/finally region, `inspect(ralphNode)` falls through to `default` and reports the ralph as terminal and successful regardless of whether any iteration has run.

In the `saga` branch of `walk()` (lines 394-420) the code only schedules a child via `return walk(child)` when `!status.terminal`. Because `inspect(ralph)` returns `terminal:true`, `walk(child)` is never invoked for the ralph, so the ralph's tasks are never pushed to `runnable` and `readyRalphs` is never populated; the loop counts as a `completedAction` and the saga returns `{ terminal:true }`. The `try-catch-finally` branch behaves the same way via the same `inspect()` calls. `collectFailureKeys()` (lines 254-292) also lacks a `ralph` case, so failures inside such a ralph are never collected for recovery.

Reproduced directly against `scheduleTasks`: a Saga whose single action is a Ralph containing one pending task `t1` yields `runnable: []`, `readyRalphs: []`, `pendingExists: false` (identical result for the same Ralph inside a TryCatchFinally), whereas the same Ralph at top level yields `runnable: [t1]`. With no runnable, no pending, and nothing in-flight, `decide()` falls straight through to `finishedResult()`, so the run completes "successfully" without ever executing the loop body. `buildPlanTree` permits this nesting (only Ralph-inside-Ralph throws), so it is reachable from authored JSX, producing silent loss of all loop work and premature run completion.

**Fix:** Add a `case "ralph"` to both `inspect()` and `collectFailureKeys()` in scheduleTasks.js that recurses into `node.children` with the same aggregation semantics as a sequence/group while honoring `ralphState[node.id].done` (a not-done, non-terminal ralph must report `terminal:false`). Likewise add a `continue-as-new` case (non-terminal). Alternatively route saga/tcf region scheduling through `walk()` rather than `inspect()` so ralph handling is shared.

*Verifier:* Confirmed in real code. inspect() (lines 129-249) has no case "ralph"; a ralph node falls to default (line 246-247) returning {terminal:true, failed:false}. The saga walk branch only descends with walk(child) when !status.terminal (line 401/413), so a ralph action child is counted as a completedAction (line 419) and never scheduled; the saga returns {terminal:true} (line 422). The try-catch-finally branch gates descent the same way (lines 463/475). readyRalphs/runnable stay empty, so decide() finishes the run without running the loop body. collectFailureKeys() (254-292) likewise lacks a ralph case. Reachability verified in buildPlanTree.js: saga-action and tcf children are walked with parentIsRalph:false (lines 102-106, 163-167); only Ralph-in-Ralph throws NESTED_LOOP (75-77), so a Ralph inside Saga/TCF builds a kind:'ralph' PlanNode and is authorable from JSX. Genuine logic defect causing silent premature completion / loss of loop work.

### 19. [HIGH · security] `packages/server/src/index.js:372`  _(corroborated ×4)_

**Path traversal / arbitrary module load (RCE) in resolveWorkflowPath when rootDir is unset**

`resolveWorkflowPath(workflowPath, rootDir)` only enforces containment when `rootDir` is provided:
```
const base = rootDir ? resolve(rootDir) : process.cwd();
const resolved = resolve(base, workflowPath);
if (rootDir) { /* containment check */ }
return resolved;
```
`startServer`/`startServerInternal` make `rootDir` optional (ServerOptions has no required rootDir, and the public docs example for `startServer` omits it). When it is unset there is NO containment check, so the client-supplied `body.workflowPath` (POST /v1/runs and /v1/runs/:id/resume, lines 695/710 and 781/796) can be an absolute path (`resolve` ignores `base` for absolute inputs) or a `../../` traversal. `loadWorkflow(absPath)` then reads that file, writes a shadow copy, and `import()`s it (lines 161-173) — importing ANY JS/TS module executes its top-level code. Combined with the optional auth default (see separate finding), this is an unauthenticated remote-code-execution / arbitrary-file-read primitive against any process that calls `startServer` without rootDir.

**Fix:** Always require/derive a rootDir and enforce containment unconditionally (default rootDir to process.cwd() and run the `resolved !== root && !resolved.startsWith(rootPrefix)` check even when no explicit rootDir was passed). Reject absolute workflowPath values that escape the root.

*Verifier:* Confirmed real path-escape. resolveWorkflowPath only checks containment when rootDir is provided; unset → no check, absolute/traversal client paths resolve anywhere and loadWorkflow import()s them (161-173), executing top-level code. Note the docs example actually includes rootDir: process.cwd() (llms-full.txt), contradicting the claim that docs omit it, but the code defect stands. The 'arbitrary-file-read' framing is overstated (import() of a non-module file throws, returning nothing) so I downgrade from critical to high: the real primitive is unsandboxed module execution / running any workflow on disk, dangerous mainly when combined with the optional-auth default.

### 20. [HIGH · security] `packages/server/src/index.js:1230`  _(corroborated ×3)_

**Server binds to all interfaces with optional auth and arbitrary-path workflow import (RCE/path traversal)**

`server.listen(port)` (line 1230) is called with no host argument, so Node binds the HTTP server to all interfaces (0.0.0.0 / ::) and there is no `host` option in ServerOptions to restrict it. Auth is optional: `const authToken = opts.authToken ?? process.env.SMITHERS_API_KEY` (line 648) and `assertAuth` returns immediately when `authToken` is falsy (lines 356-357). When no rootDir is configured, `resolveWorkflowPath` does NO containment: `const base = ... process.cwd(); const resolved = resolve(base, workflowPath)` returns `workflowPath` verbatim if it is absolute, and the path-prefix check is only run `if (rootDir)` (lines 372-383). `loadWorkflow` then dynamically `import()`s that file (line 169), executing it. Net effect: with the default config (no SMITHERS_API_KEY, no rootDir) any remote host on the network can `POST /v1/runs` with an arbitrary absolute `workflowPath` and achieve code execution / read of arbitrary modules on the host.

**Fix:** Default `server.listen(port, '127.0.0.1')` and add an explicit `host` option; require an auth token (or refuse to start on a non-loopback bind without one). Always enforce the rootDir containment check, defaulting rootDir to process.cwd() so absolute/outside paths are rejected even when rootDir is not passed.

*Verifier:* Confirmed in code. Line 1230 `server.listen(port)` has no host arg (Node binds to all interfaces); ServerOptions.ts has NO host field so a caller cannot restrict it. authToken defaults to opts.authToken ?? process.env.SMITHERS_API_KEY (648) and assertAuth returns early when falsy (356-357). resolveWorkflowPath (372-383) only runs the containment check `if (rootDir)`; with no rootDir, base=process.cwd() and resolve() returns an absolute client path verbatim, then loadWorkflow import()s it (169). All facts true. The 'arbitrary file read' part is overstated (import() of a non-ESM file throws and returns nothing), but unauthenticated network exposure + unsandboxed workflow/module execution is a genuine security defect.

### 21. [HIGH · data-loss] `packages/time-travel/src/jumpToFrame.js:916`  _(corroborated ×2)_

**Post-commit failure in resumeRunLoop/afterStep wrongly rolls back filesystem and run status after the jump already committed**

The DB jump commits durably inside `input.adapter.withTransaction(...)` (lines 725-863, dbStats assigned). AFTER that commit, the code still runs, inside the same try block whose catch is at line 916: the optional `resume-event-loop` before-hook (684/`runStepHook(input.hooks,"before","resume-event-loop")` line 884), `await input.resumeRunLoop()` (line 886), and the after-hook (line 889). `paused` is only cleared to false at line 888 AFTER resumeRunLoop returns. If any of these throw (a resume loop or user hook failing is realistic), control jumps to the catch at line 916, where the code: (1) `rollbackSandboxPointers(revertedSandboxes, ...)` reverts every sandbox working tree back to its pre-jump `previousPointer` (line 917) — but the DB frames/attempts/outputs were already truncated and committed to the target frame; (2) `restoreReconcilerState(reconcilerSnapshot)` restores the in-memory reconciler to pre-jump (line 924); (3) `markRunNeedsAttention(...)` overwrites the committed `status:"running"` with `needs_attention`/`failed` (line 950); and (4) throws `RewindFailed`. Net result: the durable DB reflects a successful jump to the target frame while the working tree(s) are reverted to the PRE-jump pointer and the run is reported failed — a permanent inconsistency between the committed control-plane state and the filesystem. The catch logic does not distinguish 'failed before commit' from 'failed after commit'; sandbox/reconciler rollback is only valid in the former case.

**Fix:** Move `resumeRunLoop`/`resume-event-loop` hooks and reconciler success handling out of the rollback-protected region, or set a `committed = true` flag immediately after `withTransaction` returns and guard the catch block so that when `committed` is true it does NOT revert sandboxes, does NOT restore the reconciler, and does NOT mark the run failed (at most: resume best-effort, log, and still return successResult since the durable jump succeeded).

*Verifier:* Confirmed from the code. The transaction commits durably when `dbStats` is assigned (the IIFE awaiting `input.adapter.withTransaction(...)` ends at line 863). That commit truncates frames/attempts/outputs, sets run status to 'running', and inserts the TimeTravelJumped event. The 'resume-event-loop' before-hook (884), `input.resumeRunLoop()` (886), and the after-hook (889) all execute AFTER that commit but are inside the same try block (opened at 663) whose catch is at line 916. If any of these throw (a realistic failure for a resume loop or user hook), the catch runs rollbackSandboxPointers(revertedSandboxes,...) (917) reverting every working tree back to its pre-jump pointer, restoreReconcilerState (924), and throws RewindFailed (980). markRunNeedsAttention (950) only fires when the rollback itself errors; if the rollback succeeds cleanly the DB keeps the committed status:'running' at the target frame while the working tree is back at the newer pre-jump state. Either way the durable DB (rewound) and the filesystem/reconciler (reverted to pre-jump) are inconsistent. The catch does not distinguish pre-commit from post-commit failure.

## MEDIUM (124)

### 22. [MEDIUM · logic] `apps/cli/src/agent-detection.js:180`

**Vibe availability probe ignores config.toml/.env auth and marks file-configured Vibe unusable**

The Vibe detector declares its auth lives in files: `authSignals` returns `[vibeHome/.env, vibeHome/config.toml]`, and `setupHint` tells users to "run `vibe --setup` to configure an API key, OR set MISTRAL_API_KEY". But the live probe only inspects the env var:
```js
availabilityProbe: (_homeDir, env) => env.MISTRAL_API_KEY
    ? passProbe("$MISTRAL_API_KEY is set")
    : failProbe("$MISTRAL_API_KEY is not set"),
```
In `detectAvailableAgents`, when the binary exists the probe always runs, and a failed probe pushes "availability check failed" into `unusableReasons`, forcing `usable=false` (lines 701-705). So a user who configured Vibe via `vibe --setup` (key written to `~/.vibe/config.toml`, no `MISTRAL_API_KEY` exported) has `hasAuthSignal=true` yet is reported UNUSABLE because the probe vetoes the valid file-based auth. The probe is strictly stricter than, and inconsistent with, the detector's own authSignals. This is a regression from the 'probe live availability' change: previously the auth-file signal alone made Vibe usable.

**Fix:** Make the probe fall through to the file-based signals like the codex/opencode probes do: if `MISTRAL_API_KEY` is unset, check `jsonFileHasContent`/contents of `config.toml`/`.env` before returning failProbe.

*Verifier:* Confirmed. The Vibe detector (lines 172-182) declares authSignals as [vibeHome/.env, vibeHome/config.toml] and setupHint mentions `vibe --setup` config-file auth, but availabilityProbe checks ONLY env.MISTRAL_API_KEY. Unlike every other detector (claude/codex/opencode all fall through to file checks), Vibe's probe never inspects config.toml/.env. In detectAvailableAgents the probe runs whenever the binary exists (line 684-686) and a failed probe pushes 'availability check failed' into unusableReasons forcing usable=false (lines 701-705, 718). So vibe binary + config.toml present + no MISTRAL_API_KEY env -> hasAuthSignal=true yet usable=false. Genuine inconsistency that mislabels file-configured Vibe as unusable.

### 23. [MEDIUM · crash] `apps/cli/src/agent-detection.js:805`  _(corroborated ×3)_

**labelToCamel can emit an invalid JS identifier, breaking the whole generated agents.ts**

`labelToCamel` does not guarantee the result is a valid identifier. For the first segment it keeps the raw text (`i === 0 ? part : ...`), so a label that starts with a digit, e.g. `2024-work`, yields `2024Work`; the pool/tier code then emits `providers.2024Work` (line 862, 884, 958, via `renderAccountProviderLine`/`renderTierLine`), which is a syntax error. A label consisting only of non-alphanumeric characters (or non-ASCII, e.g. `!!!` or a CJK label) produces an empty string after `.split(/[^a-zA-Z0-9]+/).filter(Boolean)`, yielding an empty object key `  : new ...()` and `providers.` references. `addAccount` only validates that the label is non-empty after trim (packages/accounts/src/addAccount.js), so these labels are accepted. The result is that the entire generated `.smithers/agents.ts` is syntactically invalid and `smithers init`/agent loading fails for that workspace, not just for one provider.

**Fix:** Sanitize the camelized identifier: strip/replace leading digits (e.g. prefix `a`), and fall back to a safe slug when the camel result is empty. Alternatively validate labels against an identifier-safe pattern in `addAccount` and reject otherwise.

*Verifier:* Confirmed, same root defect as [3] from the pool/tier angle. labelToCamel doesn't guarantee a valid identifier; digit-leading labels (e.g. '2024-work' -> '2024Work') reach providers.2024Work in pool/tier lines (lines 862, 882-884, 958) producing a syntax error that invalidates the ENTIRE agents.ts. Underscore-only labels ('___') pass the wizard regex and yield an empty key. Minor inaccuracy: the claim's CJK/'!!!' examples are actually rejected by the wizard regex /^[A-Za-z0-9._-]+$/, but the digit-leading and punctuation-only cases hold, so the defect is real.

### 24. [MEDIUM · security] `apps/cli/src/agent-detection.js:919`

**Account apiKey is baked as plaintext into the generated agents.ts**

`renderAccountProviderLine` emits `apiKey: ${JSON.stringify(account.apiKey)}` (line 919) for API-key providers, writing the raw secret directly into `.smithers/agents.ts`. Unlike `configDir`, which is rewritten to a portable `path.join(homedir(), ...)` expression precisely so a checked-in agents.ts doesn't bake in machine-specific data (see pathLiteral comment), the API key is embedded verbatim. If a user commits the generated `.smithers/agents.ts` (a normal, source-looking file), the secret leaks into version control. The Account type doc acknowledges plaintext storage in accounts.json (mode 600) and suggests using an empty string + env override, but the generator copies the key into a far more easily-committed file with no warning.

**Fix:** Do not inline the literal apiKey; instead emit a reference that reads from the account registry / matching provider env var at runtime (e.g. `apiKey: process.env.OPENAI_API_KEY`), or omit it and rely on accountToProviderEnv, so the generated file contains no secret.

*Verifier:* Confirmed. renderAccountProviderLine line 919 emits `apiKey: ${JSON.stringify(account.apiKey)}` verbatim into .smithers/agents.ts (written via workflow-pack.js:4518-4519). The wizard stores the real key (agentAddWizard.js:163-170, apiKey=key) and tells the user it is 'kept locally in ~/.smithers/accounts.json, mode 0600' — but it is also baked into agents.ts, which is NOT in .smithers/.gitignore (verified: node_modules, executions, runs, *.db... no agents.ts). Unlike configDir which is portability-rewritten via pathLiteral, the secret is embedded raw with no warning, so committing the normal-looking agents.ts leaks it to VCS.

### 25. [MEDIUM · error-handling] `apps/cli/src/ask.js:412`

**`smithers ask --no-mcp` still requires a working MCP probe, defeating the prompt-only fallback**

`--no-mcp` maps to `noMcp: true` (index.js:6100) which selects the `prompt-only` bootstrap mode, and the `--mcp` option is documented as "Use --no-mcp for prompt-only fallback." (index.js:6095). The system prompt for prompt-only even states "MCP is disabled or unavailable for this run." Despite this, `ask()` ALWAYS spawns and probes the live MCP server before building the contract:
```
const transport = new StdioClientTransport({ command: launchSpec.command, args: launchSpec.args, cwd, stderr: "pipe" });
...
try { await client.connect(transport); const listed = await client.listTools(); ... }
catch (error) { throw new SmithersError("ASK_BOOTSTRAP_FAILED", `Failed to probe the live Smithers MCP tools: ...`); }
```
There is no branch on `options.noMcp` / `selection.bootstrapMode === "prompt-only"`. Consequence: in exactly the environments where prompt-only fallback exists for (MCP server can't start, e.g. CI box with no agent CLIs / sandbox), `smithers ask --no-mcp "q"` hard-fails with ASK_BOOTSTRAP_FAILED instead of running the agent prompt-only. The same forced probe also gates `--dump-prompt` and `--print-bootstrap`, so even diagnostic invocations fail when MCP is unavailable. This contradicts the feature's stated purpose.

**Fix:** Skip the MCP probe when `options.noMcp` (or `selection.bootstrapMode === "prompt-only"`). In that case build the contract with an empty/known tool list (createSmithersAgentContract with tools: []) rather than spawning StdioClientTransport, so the prompt-only path never depends on a live MCP server.

*Verifier:* Confirmed in apps/cli/src/ask.js. The ask() function at lines 412-449 unconditionally constructs a StdioClientTransport, calls client.connect(transport) and client.listTools(), and throws SmithersError('ASK_BOOTSTRAP_FAILED') on any failure. There is NO branch on options.noMcp or selection.bootstrapMode anywhere before this probe. resolveBootstrapMode(agentId, noMcp) returns 'prompt-only' when noMcp is true (lines 43-45), and buildSystemPrompt emits 'MCP is disabled or unavailable for this run.' for prompt-only (line 241), yet the probe still runs first. index.js:6095 documents '--no-mcp for prompt-only fallback' and index.js:6100 maps --no-mcp to noMcp:true. The forced probe also gates the --dump-prompt/--print-bootstrap short-circuit (line 457 is after the probe) and the antigravity/pi agents which are prompt-only by default. So `smithers ask --no-mcp` (and prompt-only-by-default agents) hard-fail with ASK_BOOTSTRAP_FAILED whenever the MCP server cannot start, defeating the documented fallback. Severity medium: it requires the MCP server (the smithers CLI itself) to fail to launch, which is not the common case, but the logic is genuinely inconsistent with the feature's stated purpose.

### 26. [MEDIUM · data-loss] `apps/cli/src/hijack-session.js:185`

**Assistant turn silently dropped when agent returns an empty response.messages array**

In launchConversationHijackSession the response-message resolution is:

```
const responseMessages = stepMessages.length > 0
    ? stepMessages
    : Array.isArray(result?.response?.messages)
        ? (cloneJsonValue(result.response.messages) ?? result.response.messages)
        : [{ role: "assistant", content: result?.text ?? "" }];
```

The text fallback `[{ role: "assistant", content: result?.text ?? "" }]` only fires when `result.response.messages` is NOT an array. If an agent's `generate()` returns `response.messages === []` (an empty array) and never fires `onStepFinish` with messages, `Array.isArray([])` is true, so `responseMessages` becomes `[]`. The assistant's reply (which was already streamed to stdout via onStdout) is then NOT appended to `messages`, so `messages = [...nextMessages]` records only the user turn. The conversation history persisted by persistConversationHijackHandoff (index.js:4703) loses the assistant turn, and a subsequent turn sends two consecutive user messages with no assistant message between them. The asymmetry (undefined→text fallback, []→silent drop) is the concrete defect.

**Fix:** Treat an empty messages array the same as a missing one: e.g. `const respMsgs = Array.isArray(result?.response?.messages) && result.response.messages.length > 0 ? clone(...) : [{ role: 'assistant', content: result?.text ?? '' }]`, and use stepMessages only when non-empty (already handled).

*Verifier:* Confirmed at hijack-session.js:185-189. The resolution falls to result.response.messages when stepMessages is empty, and Array.isArray([]) is true so an empty messages array yields responseMessages=[] (text fallback never fires). This is not just a theoretical edge: BaseCliAgent.generate() (BaseCliAgent.js:1262) returns buildGenerateResult(...), and buildGenerateResult.js ALWAYS sets response.messages: [] (and steps: []) while putting the reply in `text`. BaseCliAgent.generate never invokes onStepFinish (it only calls onStdout/onStderr at lines 855/936/941), so stepMessages stays empty for every CLI agent. Result: messages=[...nextMessages] records only the user turn, assistant reply is dropped. persistConversationHijackHandoff (called from index.js:4703 with result.messages) then persists conversation history missing all assistant turns, producing consecutive user messages on the next hijack. Genuine data loss on the default CLI-agent path; raised severity from low to medium.

### 27. [MEDIUM · logic] `apps/cli/src/index.js:570`

**isRunStatusTerminal (used by `smithers watch`) omits waiting-quota**

`isRunStatusTerminal` shares the same defect as `watch_run` and feeds the CLI `watch` command (`isTerminal: (snapshot) => isRunStatusTerminal(snapshot.status)` at index.js:4197/4765/4837):

```js
function isRunStatusTerminal(status) {
    return (status !== "running" &&
        status !== "waiting-approval" &&
        status !== "waiting-timer" &&
        status !== "waiting-event");
}
```

A run in `waiting-quota` (quota/rate-limit pause, e.g. Claude 5-hour limit) is reported as terminal, so `smithers watch` exits early and reports the run as done while it is still pending resumption. Same root cause as the semantic-tools finding; fixing one does not fix the other.

**Fix:** Add `status !== "waiting-quota"` to the conjunction, ideally exporting one shared waiting-status set reused by both watch.js/index.js and the MCP watch_run tool.

*Verifier:* Confirmed. isRunStatusTerminal (index.js:572-576) excludes running/waiting-approval/waiting-timer/waiting-event but NOT waiting-quota, which is a real run status (driver/RunStatus.ts, engine.js:5183 markRunWaiting('waiting-quota'), db allowed statuses). It feeds the watch loops' isTerminal at 4167/4199/4767/4839, so `smithers watch` treats a quota/rate-limit-paused run as terminal and exits early, reporting it done while it is still pending resumption.

### 28. [MEDIUM · correctness] `apps/cli/src/index.js:845`

**`logs --follow-ancestry --since N` filters ancestor events by the wrong seq namespace and replays from seq 0**

In `streamRunEventsCommand`, the ancestry branch builds `merged` from events of every run in the lineage (each tagged with its own per-run `seq`), then filters with a single global cursor:

```js
initialEvents = c.options.since !== undefined
    ? merged.filter((event) => (event.seq ?? -1) > c.options.since)
    : merged.slice(-c.options.tail);
const lastCurrentEvent = [...initialEvents].reverse().find((event) => event.runId === c.args.runId);
lastSeq = lastCurrentEvent?.seq ?? -1;
```

Two concrete defects:
(1) `--since N` is documented as a single event sequence number, but in ancestry mode each lineage run has an independent `seq` sequence starting at 0. Filtering `merged` (events from all runs) by `event.seq > N` drops the first N events of EVERY ancestor run and keeps the rest, producing incoherent output that has nothing to do with a real cursor position.
(2) When no current-run event survives the filter (e.g. N >= the current run's max seq, or the visible window is all ancestor events), `lastCurrentEvent` is undefined and `lastSeq` falls back to `-1`. The follow loop at line 886 then calls `adapter.listEvents(c.args.runId, lastSeq, 200)` with afterSeq=-1, which re-streams the current run's events from seq 0 — directly contradicting `--since` and duplicating already-suppressed output.

**Fix:** Track the cursor per run (or only apply `--since` to the current run's events, leaving ancestor events unfiltered). When deriving `lastSeq` for the follow loop, initialize it from the current run's actual last-seen seq (e.g. `getLastEventSeq` for the current run when no current event is in the initial window) instead of falling back to -1, so follow never replays from the beginning.

*Verifier:* Confirmed at index.js:846-853. In the includeAncestry branch, `merged` aggregates events from every lineage run, each tagged with its own per-run seq, then filters with a single global threshold `event.seq > c.options.since` — incoherent across independent per-run seq namespaces. When no current-run event survives the filter, lastCurrentEvent is undefined and lastSeq falls back to -1, so the follow loop at 888 (`listEvents(runId, -1, 200)`) re-streams the current run from seq 0, contradicting --since. Niche combo (--follow-ancestry + --since) but genuinely wrong.

### 29. [MEDIUM · api-misuse] `apps/cli/src/index.js:1921`

**Detached run forwards `--metrics false`, which the parser reads as metrics=true (should be `--no-metrics`)**

In the detach branch: `if (options.serve && !options.metrics) childArgs.push("--metrics", "false");` (lines 1920-1921). `metrics` is declared as `z.boolean()` (line 1473). The incur parser treats a bare boolean flag as `true` and does NOT consume the following token (Parser.ts lines 46-48): seeing `--metrics` sets `metrics=true` and leaves `"false"` as a stray positional (silently discarded since only the first positional, the workflow path, is bound — Parser.ts:96-104). The space-separated value form only works for non-boolean flags; the value form for booleans must be `--metrics=false`. Net effect: a user who runs `smithers up wf.tsx --detach --serve --no-metrics` (intending to disable the /metrics endpoint) gets a detached child with metrics ENABLED, contradicting their flag. Note the same file correctly uses negation form for the `log` boolean (`--no-log`, lines 1878-1879), so this is an inconsistency, not a parser limitation.

**Fix:** Replace `childArgs.push("--metrics", "false")` with `childArgs.push("--no-metrics")` (incur auto-generates the `--no-<flag>` negation for boolean options), matching the `--no-log` pattern.

*Verifier:* Confirmed. index.js:1922-1923 pushes `--metrics false` to the detached child. metrics is z.boolean() (index.js:1475). incur Parser.ts:46-48: a bare boolean flag sets the option true and advances i by only 1, leaving 'false' as a stray positional that is discarded (only the first positional binds, Parser.ts:96-104). So the child gets metrics=ENABLED, contradicting --no-metrics. The correct form is `--metrics=false` or `--no-metrics`; the file even uses `--no-log` correctly at 1880-1881.

### 30. [MEDIUM · security] `apps/cli/src/index.js:2980`

**`smithers agents list --format json` leaks plaintext API keys to stdout**

The human-readable branch deliberately masks the credential: `const where = a.configDir ?? (a.apiKey ? "(api key set)" : "");` and only prints "(api key set)". But the structured return `return c.ok({ accounts });` hands Incur the full account objects. For `--format json` (or `--format` machine output), Incur writes `result.data` verbatim to stdout (`write({ ok: true, data: result.data, ... })` in incur/dist/Cli.js). Account objects carry `apiKey` as the raw key in plaintext (see packages/accounts/src/Account.ts: "Raw API key. ... Stored in plaintext"). So `smithers agents list --format json` dumps every stored API key to stdout, where it can be captured by shell logging, CI logs, pipes, or screen-shares. The masking in the human path shows the clear intent NOT to expose the key, making the JSON path an inconsistent secret leak. The sibling commands `agents test` (line 3026, `return c.ok({ account, ping })`) and `agents add` flag-mode (line 2949, `result.account`) have the same exposure for the single returned account.

**Fix:** Strip/redact `apiKey` before returning, e.g. `const safe = accounts.map(({ apiKey, ...rest }) => ({ ...rest, hasApiKey: Boolean(apiKey) })); return c.ok({ accounts: safe });` and apply the same redaction in `agents test` and `agents add`.

*Verifier:* Confirmed. agents list returns c.ok({ accounts }) (index.js:2982) where listAccounts() returns full Account objects including apiKey (listAccounts.js -> readAccounts; parseAccountsFile.js:103 sets apiKey; Account.ts:24 apiKey?:string, documented plaintext). The human branch masks to '(api key set)' (index.js:2978) but for --format json incur serializes output.data verbatim (Cli.js:805-806). So `agents list --format json` writes raw API keys to stdout. Siblings `agents test` (c.ok({account,ping}), 3028) and `agents add` flag-mode (c.ok({account:...}), 2950-2953) have the same leak.

### 31. [MEDIUM · logic] `apps/cli/src/index.js:4388`

**`smithers chat` drops the latest attempt's output due to premature first syncAttempts() call**

In the `chat` command, `syncAttempts(initialAttempts)` is called twice. The first call at line 4388 runs BEFORE `knownOutputAttemptKeys` is populated (that happens at lines 4393-4395 from `parsedInitialOutputs`). `syncAttempts` permanently seeds `selectedAttemptKeys` whenever `c.options.all || selectedAttemptKeys.size === 0`:
```js
syncAttempts(initialAttempts);                                  // (1) knownOutputAttemptKeys EMPTY
...populate knownOutputAttemptKeys...
const selectedInitialAttempts = syncAttempts(initialAttempts);  // (2) full knownOutputAttemptKeys
```
`selectChatAttempts` uses `isAgentAttempt`, which only counts an attempt that has `responseText` / `meta.kind==='agent'` UNLESS its key is in `outputAttemptKeys`. So with an empty set, call (1) can select an older completed attempt (one with `responseText`) and add it to `selectedAttemptKeys`. After `knownOutputAttemptKeys` is filled, call (2) picks the truly-latest attempt (an in-progress one that only has output events) and returns it as `selectedInitialAttempts`, but because `selectedAttemptKeys.size !== 0` it does NOT update `selectedAttemptKeys`. The prompt/fallback loops (lines 4398, 4408) iterate `selectedInitialAttempts` (the latest attempt) while `buildOutputBlock` (line 4329) filters output events by `selectedAttemptKeys` (the older attempt). Result: the header for the latest attempt is printed but its actual chat output is filtered out, so the user sees an empty block for the attempt they most want to read.

**Fix:** Remove the premature first `syncAttempts(initialAttempts)` call at line 4388 so `selectedAttemptKeys` is only seeded after `knownOutputAttemptKeys` is computed; rely on the second call (line 4396) for both `selectedAttemptKeys` and `selectedInitialAttempts`.

*Verifier:* Confirmed mechanism. syncAttempts is called at index.js:4390 BEFORE knownOutputAttemptKeys is populated (4395-4397), and it permanently seeds selectedAttemptKeys when selectedAttemptKeys.size===0 (4382-4386). selectChatAttempts/isAgentAttempt (chat.js:155-184) only count an attempt without meta.kind==='agent' and without responseText if its key is in outputAttemptKeys. With the empty set, call (1) can seed an older completed attempt; call (2) at 4398 returns the truly-latest (output-only) attempt but does not update selectedAttemptKeys (size!=0). buildOutputBlock filters by selectedAttemptKeys (4331) while prompt/fallback loops iterate selectedInitialAttempts (4400/4410), so the latest attempt's header prints but its output is filtered out. Requires the output-only-key attempt class to exist (the very reason knownOutputAttemptKeys exists), hence medium confidence.

### 32. [MEDIUM · error-handling] `apps/cli/src/index.js:7118`

**Raw-JSON timeline fast path can throw an unhandled rejection (no try/catch)**

In main(), `if (await runRawJsonTimelineCommandIfMatched(argv)) return;` (line 7118) is awaited outside any try/catch, and `main()` is called with no `.catch` (line 7248). Inside `runRawJsonTimelineCommandIfMatched` (lines 6836-6882) the call `const { adapter, cleanup } = await findAndOpenDb();` is *before* the try block, and `buildTimeline`/`buildTimelineTree` run inside the try but only have a `finally { cleanup(); }` — no catch. All of these can reject: `findAndOpenDb()` throws when no DB exists or when `SMITHERS_MIGRATION_REQUIRED`, and `buildTimeline`/`buildTimelineTree` resolve `Effect`s that fail with `SmithersError` (e.g. run not found). When that happens the rejection propagates out of `main()` unhandled, dumping a stack trace to stderr and exiting via Node's unhandled-rejection path. The regular `timeline` command (lines 6499-6537) wraps the exact same work in try/catch and returns a structured `{ code: 'TIMELINE_FAILED', ... }` error. So `smithers timeline <missing-id> --json` (or in a workspace needing --backend) crashes ugly and, worse, a JSON consumer gets an unparseable stack trace instead of a clean error envelope.

**Fix:** Wrap the body of runRawJsonTimelineCommandIfMatched in try/catch (mirroring the timeline command): on error, emit a structured JSON error to stdout and set a non-zero exit, then return true; ensure cleanup is only called when adapter was successfully opened. Alternatively, guard the call site in main() with try/catch.

*Verifier:* Confirmed. main() awaits runRawJsonTimelineCommandIfMatched(argv) at index.js:7120 outside any try/catch, and main() is invoked at 7250 with no .catch. Inside the helper (6838-6884), findAndOpenDb() at 6873 is before the try, and buildTimeline/buildTimelineTree run inside a try with only finally{cleanup()} (no catch). findAndOpenDb throws on missing DB/migration-required and the timeline builders reject on run-not-found, so `smithers timeline <missing> --json` yields an unhandled rejection (stack trace, no clean error envelope), unlike the regular timeline command which returns a TIMELINE_FAILED envelope.

### 33. [MEDIUM · error-handling] `apps/cli/src/optimize-command.js:115`

**SIGINT during the baseline phase does not halt the optimize pipeline; a second abort handler set is also leaked**

`executeEvalPlan` creates its own `AbortController` via `const abort = input.setupAbortSignal();` (line 115) and `runOptimizeCommand` calls `executeEvalPlan` twice — once for the baseline plan (line 292) and once for the optimized plan (line 316). Two problems result:

1. Cancellation does not propagate across phases. When the user hits Ctrl-C while the BASELINE run is in flight, only the baseline `AbortController` is aborted. The per-case `catch` in `runWithLimit`'s worker swallows the abort rejection and turns each case into an `{ status: "error" }` result (lines 157-176), so `executeEvalPlan` RESOLVES normally with a report full of error results. `runOptimizeCommand` then happily continues: it calls `buildProviderGepaPatches` (the GEPA provider request, line 303) and launches the entire OPTIMIZED eval run (line 316) with a brand-new, non-aborted `AbortController`. So a single Ctrl-C does not stop the command — it merely corrupts the baseline data and lets the rest of the (expensive, agent-driven) pipeline run. The only thing that eventually kills it is the unref'd 5s force-exit backstop timer inside `setupAbortSignal`, which hard-`process.exit()`s mid-optimization.

2. Listener leak / duplicate handlers. `setupAbortSignal` registers fresh `process.on('SIGINT'|'SIGTERM')` listeners on every call (apps/cli/src/index.js:563-564). Calling it twice per optimize invocation registers two independent handler sets, each with its own `signalCount` closure and its own 5s timer. On SIGINT this prints the '[smithers] received SIGINT, cancelling run...' message twice and arms two force-exit timers, and the dead baseline handler stays installed for the whole optimized phase.

**Fix:** Create a single AbortController once in runOptimizeCommand (call deps.setupAbortSignal() one time), thread its signal into both executeEvalPlan calls, and check `abort.signal.aborted` between phases (after the baseline run and before GEPA/optimized run) to short-circuit the pipeline when cancellation was requested. Change executeEvalPlan to accept the signal/controller instead of calling setupAbortSignal itself.

*Verifier:* Confirmed in actual code. executeEvalPlan (optimize-command.js:115) calls input.setupAbortSignal(), creating a fresh AbortController per call, and runOptimizeCommand calls executeEvalPlan twice (baseline line 292, optimized line 316), each with its own controller. setupAbortSignal (index.js:537-567) registers process.on('SIGINT'/'SIGTERM') handlers that are never removed (process.on, not once) and arms an unref'd 5s process.exit backstop in handleSignal. (1) Cross-phase cancellation does not propagate: aborting the baseline controller has no effect on buildProviderGepaPatches (line 303) or the optimized run, which builds a brand-new non-aborted controller. The per-case catch at 157-176 swallows the abort rejection from runWorkflow(signal: abort.signal) and turns each case into a {status:'error'} result, so executeEvalPlan resolves normally on abort and runOptimizeCommand continues. The only forced stop is the unref'd 5s force-exit timer, so a single Ctrl-C corrupts baseline data and lets the pipeline keep spending until a hard process.exit. (2) Listener leak is real: two setupAbortSignal calls register two independent handler sets; during the optimized phase a SIGINT triggers both, printing '[smithers] received SIGINT, cancelling run...' twice, arming two 5s timers, with the dead baseline handler still installed. Both sub-claims are verifiable; the only exaggeration is timing-dependent (the optimized phase only fully runs if it begins within the 5s backstop window), so I keep severity at medium rather than higher. The cleaner design would create one AbortController in runOptimizeCommand and propagate it.

### 34. [MEDIUM · crash] `apps/cli/src/resume-detached.js:29`  _(corroborated ×2)_

**Detached resume spawn has no 'error' listener — async spawn failure crashes the long-lived supervisor**

`resumeRunDetached` does `const child = spawn("bun", args, {... detached:true, stdio:"ignore"}); child.unref(); return child.pid ?? null;` with no `child.on('error', ...)` listener. The supervisor calls this via `Effect.try` in `processCandidateEffect`/`processTimerCandidateEffect`/`processApprovalDecidedCandidateEffect` (supervisor.js ~220, ~303, ~392). `Effect.try` only catches the SYNCHRONOUS return of `spawn()`. When the process cannot actually be launched (e.g. `bun` is not on PATH, ENOENT, EACCES), Node emits an asynchronous `'error'` event on the ChildProcess. With no listener, Node re-throws it as an uncaught exception, which the Effect runtime cannot catch. For a long-running durability daemon (`smithers supervise`), a single transient spawn failure therefore crashes the entire supervisor loop instead of being logged and skipped. The synchronous return value `child.pid` will also be `undefined` in that case, so the supervisor reports `RunAutoResumed` even though nothing started.

**Fix:** Attach `child.on('error', (err) => { /* log */ })` before returning, and surface the failure to the supervisor (e.g. return null / throw synchronously only) so the resume path treats it as a skip. At minimum a no-op error listener prevents the uncaught-exception crash.

*Verifier:* Same root cause, confirmed against the callers. supervisor.js wraps the spawn in `Effect.try` at lines 220, 303, and 392 (processCandidate/Timer/ApprovalDecided), with spawnResumeDetached bound to resumeRunDetached (line 57). Effect.try only catches a SYNCHRONOUS throw from the wrapped function; spawn returns normally and any launch failure (ENOENT/EACCES) surfaces later as an async 'error' event on the ChildProcess. With no listener and no uncaughtException handler in the process, that async event crashes the `smithers supervise` daemon rather than being logged and skipped. The secondary claim is also consistent: on a failed spawn `child.pid` is undefined so the function returns null, yet the synchronous path succeeds (no throw), so the supervisor would treat it as resumed. Real defect for a long-running daemon; medium severity.

### 35. [MEDIUM · concurrency] `apps/cli/src/scheduler.js:48`

**Cron re-spawns workflow every tick when the schedule-advance DB write fails**

In processCronEffect the workflow is spawned FIRST (lines 31-40), then the next run time is computed and persisted via `yield* adapter.updateCronRunTimeEffect(job.cronId, now, nextRunAtMs)` (line 48). If that persist fails (this repo explicitly shares one SQLite DB across concurrent agents, so write-lock contention / transient failures are expected), the gen effect fails and control jumps to the catchAll, which writes `updateCronRunTimeEffect(job.cronId, failedAtMs, job.nextRunAtMs ?? failedAtMs + 60_000, errorMessage)` (line 54). `job.nextRunAtMs` is the ORIGINAL due time which is already in the past, so the cron row's nextRunAtMs is never advanced to the future. Moreover that catchAll write hits the same DB and can also fail (it is only logged, line 55). On the next tick (default 15s) `now < job.nextRunAtMs` is false, the job is still 'due', and the detached workflow is spawned AGAIN. A single transient DB blip therefore produces a runaway burst of duplicate detached workflow launches until a write finally succeeds.

**Fix:** Compute and persist the next run time BEFORE spawning, or guard the spawn so it only fires after the schedule has been durably advanced. At minimum, on the failure path advance nextRunAtMs to a future time (e.g. always `failedAtMs + 60_000`, never the stale past `job.nextRunAtMs`) so a failed persist cannot leave the job perpetually due.

*Verifier:* Confirmed in apps/cli/src/scheduler.js. processCronEffect spawns the detached workflow first (lines 30-40), then computes nextRunAtMs (41-47), then persists it via updateCronRunTimeEffect(job.cronId, now, nextRunAtMs) (line 48). The whole gen is wrapped in catchAll (line 49). On any failure the error path writes updateCronRunTimeEffect(job.cronId, failedAtMs, job.nextRunAtMs ?? failedAtMs + 60_000, errorMessage) (line 54). packages/db/src/adapter.js:2643-2644 confirms the 3rd arg is written to the _smithers_cron.nextRunAtMs column, which schedulerTickEffect reads at line 67 (now < job.nextRunAtMs). Since a due job has job.nextRunAtMs in the past, the catchAll write keeps the row at the original past timestamp, so it stays due and processCronEffect re-spawns the already-launched workflow on the next tick. The catchAll write can also fail and is only logged (line 55), leaving the row unchanged with the same effect. Thus a transient persist failure at line 48 (plausible under the repo's shared-SQLite write contention) yields repeated duplicate detached launches until a write succeeds. Root cause: spawn-before-persist ordering with no idempotency plus retaining the original past nextRunAtMs on error. Real defect; medium severity since it requires a DB write failure to trigger.

### 36. [MEDIUM · correctness] `apps/cli/src/tui.js:72`

**Runs that pause on waiting-event/waiting-timer are misreported as a hard failure (exit 1)**

`TERMINAL_STATES`/`STOP_STATES` deliberately include only `waiting-approval`, omitting `waiting-event` and `waiting-timer`:
```
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "waiting-approval"]);
const STOP_STATES = new Set([...TERMINAL_STATES, "stale", "orphaned"]);
```
The detached `smithers up` process exits whenever the run reaches ANY waiting-* state (apps/cli/src/index.js:2180 sets `process.exitCode = formatStatusExitCode(result.status)`, which returns 3 for `waiting-event`/`waiting-timer` too). When a workflow pauses awaiting an external signal or a timer, the child exits, `childFailure` resolves, and in `streamRun` the `waited?.error` branch re-fetches the run state (line 619-630): since `waiting-event`/`waiting-timer` are NOT in `STOP_STATES`, it does not `break` and instead returns `{ state: 'waiting-event', error: childExitError }`. Back in `runTuiCommand`, `listPendingApprovals`/`listPendingHumanRequests` are empty (a signal/timer is not an approval or human request), so `result.error` is set and the code returns `fail({ code: "TUI_RUN_EXITED", message: "Run process exited (exit 3)...", exitCode: 1 })` (lines 877-881). A run that is legitimately paused (the correct exit semantics elsewhere are 3 = "awaiting a decision, not a failure", index.js:2151) is presented to the user as a crashed/failed run with a misleading message and exit code 1.

**Fix:** Add `waiting-event` and `waiting-timer` to `TERMINAL_STATES` (so `streamRun` stops cleanly and renders the paused card), and in `runTuiCommand` treat a non-resolvable waiting-* state as a paused result (return `c.ok({ ran: true, runId, paused: true })`) rather than `TUI_RUN_EXITED` with exitCode 1.

*Verifier:* Confirmed. formatStatusExitCode (index.js:281-292) returns 3 for waiting-event/waiting-timer; up exits with that code (index.js:2182), and index.js:2153 explicitly documents exit 3 as 'awaiting a decision, not a failure.' tui.js STOP_STATES (lines 72-73) deliberately excludes waiting-event/waiting-timer. When the detached child exits on those states, childFailure resolves, streamRun's error branch (619-630) re-fetches state, finds it NOT in STOP_STATES, so does not break and returns {state:'waiting-event'|'waiting-timer', error: childExitError}. Back in runTuiCommand, listPendingApprovals/listPendingHumanRequests are empty for a timer/event pause, so (lines 877-880) result.error is truthy and it returns fail({code:'TUI_RUN_EXITED', exitCode:1, message:'...exit 3...'}). A legitimately paused run is thus reported as a crashed/failed run with a misleading exit-1 and 'exit 3' message. Reachable whenever a TUI-run workflow uses a timer or external signal.

### 37. [MEDIUM · correctness] `apps/cli/src/tui.js:902`

**Resuming after a gate replays the entire run event history (duplicate cards and agent output)**

`streamRun` starts each call with `let lastSeq = -1;` (line 555) and a fresh `makeNodeColorer`, `labels`, and `outputTables`. `adapter.listEvents(runId, lastSeq, 500)` returns events with `seq > afterSeq` (packages/db/src/adapter.js:2275 -> listEventHistory `{ afterSeq }`), so `-1` fetches ALL events from the beginning. In `runTuiCommand` the gate-resume loop re-invokes `streamRun` from scratch after every approval/human gate:
```
result = await streamRun(db.adapter, runId, name, promptText, { childFailure: resumeFailure });
```
Because `lastSeq` is not preserved across resumes, the second (and each subsequent) `streamRun` reprocesses the complete event history: every historical `FrameCommitted` triggers `renderCurrentCard()` (printing a whole new clack card via intro/log/outro) and every historical agent/tool/output event is re-printed via `printLine`. For any multi-step workflow with a gate in the middle, resolving the gate dumps the entire prior transcript again, corrupting the live-stream UX the function is built to provide.

**Fix:** Thread `lastSeq` (and ideally the colorer/label maps) through across resumes: accept a starting `lastSeq` in `streamRun` opts and return the final `lastSeq` in its result, then pass it into the next `streamRun` call in the resume loop so only new events stream after a gate.

*Verifier:* Confirmed. streamRun line 555 initializes let lastSeq = -1 fresh on every call (plus fresh makeNodeColorer/labels/outputTables). listEvents(runId, lastSeq, 500) -> listEventHistory({afterSeq}) builds WHERE 'seq > ?' with params [runId, query.afterSeq ?? -1] (sql-message-storage.js:919-920), so afterSeq=-1 returns ALL events from the start. The gate-resume loop in runTuiCommand re-invokes streamRun from scratch after each approval/human gate (line 902) with no preserved cursor. The second and subsequent calls reprocess the entire event history: every historical FrameCommitted runs renderCurrentCard() (re-printing a clack card via intro/log/outro) and every historical agent/tool/output/NodeFinished event is re-printed via printLine (lines 589-605). No dedup guard exists (lastRenderedState only suppresses a single final re-render at break). So resolving a mid-run gate dumps the full prior transcript again, corrupting the live-stream UX. Common case since any workflow with a mid-run gate hits the resume path.

### 38. [MEDIUM · logic] `apps/cli/src/why-diagnosis.js:280`

**dependency-failed blocker never fires: dependsOn is stripped from the persisted frame xmlJson**

`parseFrameDescriptorMetadata` reads `dependsOn: parseStringArray(props.dependsOn)` (line 280), and the entire `dependency-failed` detection loop (lines 861-885) keys off `descriptor?.dependsOn`. But `props` here come from the persisted frame `xmlJson`, which the engine builds via `canonicalizeXml(graph.xml)` (engine.js:5272). `graph.xml` element props are produced by the react-reconciler's `createElement` (packages/react-reconciler/src/reconciler.js:43-55), which only serializes props whose value is `string | number | boolean` into the stringified props and DROPS arrays/objects entirely. `Task.js` passes `dependsOn` as an array: `React.createElement("smithers:task", { ...rest, dependsOn: nextDependsOn })` (Task.js:259/269/279). Therefore the frame's `smithers:task` props never contain a `dependsOn` key, so `parseStringArray(undefined)` returns `[]`, `descriptor.dependsOn` is always empty, and the loop `if (dependsOn.length === 0) continue;` (line 864) skips every node. Result: `smithers why` can NEVER produce a `dependency-failed` blocker for a real run, so a pending node blocked by a failed upstream dependency is reported with no explanation and no CTA. The unit tests pass only because they hand-craft `dependsOn` as a string (e.g. props: { id: 'dep-b', dependsOn: 'dep-a, missing' }), a shape that the real serialization never emits. The same root cause silently disables descriptor-derived `retryPolicy` (object, dropped -> falls back to attempt meta) and the `__smithers*` event/correlation/timer props (dropped -> fall back to plain `event`/`correlationId`/etc.), but only `dependsOn` has no fallback and is fully broken.

**Fix:** Either serialize array/object descriptor props into the canonical XML frame (e.g. JSON-encode `dependsOn` to a string prop in the reconciler/extract layer so it round-trips), or have why-diagnosis source dependsOn from a representation that preserves it (the task index / taskIndexJson built from rawProps) rather than from the frame xmlJson props. Add an e2e test that runs a real workflow with a failing dependency and asserts the `dependency-failed` blocker appears.

*Verifier:* Verified the full chain. Task.js:259/269/279 passes dependsOn as an array. reconciler.js createElement (lines 50-54) only serializes string|number|boolean into `props` and drops arrays (keeping them only in a separate `rawProps`). graph/src/extract.js toXmlNode (line 151-162) builds graph.xml from `node.props` (the stringProps), NOT rawProps. engine.js:5272 persists canonicalizeXml(graph.xml), and canonicalizeNode (graph/utils/xml.js) serializes element.props only. So the persisted frame xmlJson never contains a dependsOn key. why-diagnosis.js:280 then does parseStringArray(props.dependsOn)=parseStringArray(undefined)=[], and the dependency-failed loop at 864 `if (dependsOn.length === 0) continue;` skips every node, so the `dependency-failed` blocker can never fire for a real run. The engine's own dependency resolution is unaffected because extract.js:376/432 reads node.rawProps.dependsOn. Unit tests pass only because they hand-craft props.dependsOn as a string (why-diagnosis-unit.test.js:198 'dep-a, missing', why-command.test.js:663), a shape the real serialization never emits. Real defect; impact is a dead diagnostic blocker (degraded `smithers why` output, no crash, partial coverage from retries-exhausted on the failed dep), so medium severity is appropriate.

### 39. [MEDIUM · correctness] `apps/cli/src/workflow-pack.js:3018`

**Seeded workflows pass ctx.input.prompt raw, defeating the z.string().default() and feeding null to agents when prompt is omitted**

The `vcs` workflow explicitly documents the launcher contract (lines 2906-2909): "The launcher can pass null for omitted fields, which skips the zod defaults, so coalesce here rather than trusting `.default()` to have run", and it does `ctx.input.vcs ?? 'git'`. Every prompt-based seeded workflow ignores this: implement (line 3018 `prompt={ctx.input.prompt}`), research-plan-implement (3083 `const prompt = ctx.input.prompt`), review (3201), plan (3252 `<PlanPrompt prompt={ctx.input.prompt}/>`), research (3296), ticket-create (3341), tickets-create (3389), ralph (3421), improve-test-coverage (3462) and debug (3512) all use `ctx.input.prompt` directly. Because the field arrives as `null` (not `undefined`) when omitted, the `z.string().default("Implement the requested change.")` default never applies, so the agent prompt becomes literal null. ValidationLoop coerces it to the string "null" (`JSON.stringify(prompt ?? null)` at ValidationLoop.tsx:41); MDX prompt components (PlanPrompt/ResearchPrompt/etc.) receive null. One workflow at line 4211 already guards with `ctx.input.prompt ?? ""`, confirming the inconsistency. Result: launching any of these workflows without an explicit prompt gives the agent a meaningless "null" instruction instead of the intended default.

**Fix:** Coalesce every input read to its intended default, e.g. `const prompt = ctx.input.prompt ?? "Implement the requested change.";` (and `ctx.input.tdd ?? false`), matching the vcs workflow's documented pattern, rather than relying on zod `.default()`.

*Verifier:* Confirmed contract: normalizeInputRow.js returns the raw payload (never applies zod schema defaults), and the file itself documents at 2906-2908 (vcs) and 4198 (workflow-skill) that omitted launcher fields arrive null, bypassing .default(). implement (3018) and others pass ctx.input.prompt raw. When omitted, ValidationLoop promptText = JSON.stringify(prompt ?? null) -> literal 'null' (1155), and MDX prompt components receive null/undefined. The default path is broken; vcs and workflow-skill coalesce, the prompt workflows do not. Reachable only when launched without a prompt, hence medium.

### 40. [MEDIUM · logic] `apps/cli/src/workflow-pack.js:3460`

**debug & improve-test-coverage ValidationLoops never pass done/feedback, so they run a fixed 3 iterations with no feedback and can regress passing work**

The `implement` and `research-plan-implement` workflows compute `done = validationPassed && anyApproved` and a `feedback` string and pass both to `<ValidationLoop done={done} feedback={feedback} maxIterations={3}/>` (lines 3022-3024, 3150-3152). The `improve-test-coverage` (lines 3460-3466) and `debug` (lines 3510-3516) workflows render ValidationLoop with ONLY idPrefix/prompt/agents — no `done`, no `feedback`, no `maxIterations`. In ValidationLoop (.smithers/components/ValidationLoop.tsx:38) `done` defaults to `false`, so the loop is `<Loop until={false} maxIterations={3} onMaxReached="return-last">`: it ALWAYS runs three full implement+validate+review cycles even after validation passes and a reviewer approves on iteration 1, and because `feedback` is never threaded, each iteration re-runs the SAME implement prompt with no awareness of the prior failures/rejections. For `debug` ("Reproduce and fix the reported bug") this means re-doing the fix two more times after it already succeeded, which wastes expensive agent runs and can re-break the just-fixed code. The whole point of the loop (short-circuit on success, iterate on feedback) is defeated.

**Fix:** Mirror the implement.tsx pattern in both debug and improve-test-coverage: compute `validate`, `reviews`, `validationPassed`, `anyApproved`, `done`, and `feedback`, then pass `done={done} feedback={feedback} maxIterations={3}` to ValidationLoop.

*Verifier:* Confirmed. improve-test-coverage (3460-3466) and debug (3510-3516) render ValidationLoop with only idPrefix/prompt/agents, omitting done/feedback/maxIterations. In ValidationLoop (1152-1153) done defaults false and maxIterations 3, so until={false} -> always runs 3 full implement+validate+review cycles with no short-circuit on success, and feedback is never threaded so each iteration re-runs the identical implement prompt. implement/research-plan-implement correctly pass done+feedback (3022-3024,3150-3152), confirming the omission is a real inconsistency that wastes runs and can re-break converged work.

### 41. [MEDIUM · crash] `apps/cli/src/workflow-pack.js:3833`

**Mission feature task ids can collide (DUPLICATE_ID) when planner emits same-titled features**

In the generated `mission` workflow, `featureTaskId` builds the durable node id as `mission:milestone:${milestoneIndex + 1}:feature:${feature.id}` (line 3833) and `feature.id` comes from `normalizeFeature`: `id: slugify(feature?.id ?? title, \`feature-${index + 1}\`)` (line 3794). The unique `feature-${index+1}` fallback is ONLY used when slugify returns an empty string; when a feature has a non-empty title and no explicit unique id, the slug is derived purely from the title. LLM-generated milestone plans routinely contain two features with the same/similar title in one milestone (e.g. two "Add tests" features). Both then slugify to the same value (`add-tests`), producing two `<Task>` nodes with identical ids. `assertUniqueHandleIds` in packages/engine/src/effect/builder.js throws `SmithersError("DUPLICATE_ID", "Duplicate step id ...")`, aborting the whole mission run before any work executes. The same collision also produces duplicate Worktree `path`/`branch` (lines 3920-3921) when `useWorktrees` is set, which `git worktree add` would reject. Note `ForEachFeature.tsx` deliberately avoids this by appending the index to the id (`${slugifyFeatureToken(groupName)}:${index}`); the mission generator does not.

**Fix:** Incorporate the feature's positional index into the node id (and worktree path/branch), e.g. change `featureTaskId` to `mission:milestone:${milestoneIndex + 1}:feature:${index}:${feature.id}` and thread the index through, or make `normalizeFeature` guarantee unique ids within a milestone by always appending the index when a duplicate slug is detected.

*Verifier:* Confirmed. featureTaskId (3833) = `mission:milestone:${i+1}:feature:${feature.id}` and normalizeFeature (3794) derives id = slugify(feature?.id ?? title, `feature-${index+1}`); the unique fallback only fires when slugify returns empty. Two same-titled features in one milestone -> identical slug -> duplicate Task id, and assertUniqueHandleIds (builder.js:623-627) throws SmithersError('DUPLICATE_ID'), aborting the whole run. Worktree path/branch (3920-3921) also collide. Unlike ForEachFeature, the mission generator does not append an index. LLM plans plausibly emit duplicate feature titles, so this is realistically reachable.

### 42. [MEDIUM · resource-leak] `apps/cli/src/workflow-pack.js:4348`

**Kanban maxConcurrency not coalesced; null input makes Parallel unbounded**

The generated kanban.tsx does:

  const maxConcurrency = ctx.input.maxConcurrency;
  ...
  <Parallel maxConcurrency={maxConcurrency}>

The inputSchema declares `maxConcurrency: z.number().int().min(1).max(10).default(3)`, but as the workflow-skill template itself documents one screen up (line 4198: "ctx.input fields arrive null (not their zod default) when unsupplied") and as the project memory records, ctx.input fields arrive as null, NOT the zod default, when the field isn't supplied. So running `kanban` with no maxConcurrency yields `maxConcurrency = null`.

I verified the downstream effect in packages/graph/src/extract.js pushGroup: for a Parallel, `Number(null)` = 0 -> rawMax = 0 -> `rawMax == null || rawMax <= 0` -> `max = undefined`, i.e. UNBOUNDED group concurrency. The intended cap of 3 is silently dropped, so every ticket's worktree + implement/validate/review agents launch at once (only the global run cap, not the per-group cap, limits it). The sibling mission template correctly guards this at line 3939 with `Math.min(ctx.input.maxConcurrency ?? 3, features.length)`; kanban omits the `?? 3`.

**Fix:** Coalesce to the schema default: `const maxConcurrency = ctx.input.maxConcurrency ?? 3;` (mirroring the mission workflow).

*Verifier:* Confirmed. kanban does const maxConcurrency = ctx.input.maxConcurrency (4348) with no ?? 3, passed to <Parallel maxConcurrency> (4365). Schema default is 3 but per the null-on-omit contract a CLI/gateway launch without the field yields null. extract.js (302-312): Number(null)=0 -> rawMax=0 -> rawMax<=0 -> max=undefined (unbounded group concurrency). The intended cap is dropped, launching all ticket worktrees+agents at once. The mission sibling guards with `?? 3` (3939); kanban does not. Note the kanban UI itself passes maxConcurrency=3 (useState(3)/launch at 2037), so this only bites non-UI launches, hence medium.

### 43. [MEDIUM · correctness] `apps/observability/src/_traceEventNormalizers.js:411`

**OpenAI Responses usage (nested under response) dropped in shared message_end normalizer**

In normalizeSharedStructuredEvent the `message_end` branch handles `response.completed` (the OpenAI Responses API terminal event, routed here because the `openai`/`anthropic`/`amp`/etc. families fall through to the shared normalizer). It extracts usage with `const usage = normalizeTokenUsage(parsed?.usage);`. For the OpenAI Responses API the token counts live at `parsed.response.usage` (`{input_tokens, output_tokens, ...}`), not at top-level `parsed.usage`. `_usageFieldAliases` also has no `["response", ...]` path, so `_readUsagePath` returns undefined and `normalizeTokenUsage` yields null. Result: no `usage` event is emitted for `response.completed`, so token/cost accounting is silently lost for the openai family on its final event, even though `final text` is still captured via `extractGenericMessageText` (which does look under `parsed.response`). The Claude/Gemini/Codex/Pi paths each read their provider-specific usage location, but this shared path does not handle the nested OpenAI shape.

**Fix:** Read usage from both locations, e.g. `const usage = normalizeTokenUsage(parsed?.usage ?? parsed?.response?.usage);`, or add a `["response","usage",...]`-style alias set so nested usage is picked up.

*Verifier:* Confirmed. In normalizeSharedStructuredEvent the message_end branch (lines 399-413) handles rawType 'response.completed' (line 402). rawType is parsed.type (packages/engine/src/AgentTraceCollector.js:387), so this is the OpenAI Responses API terminal event whose shape nests usage at parsed.response.usage (input_tokens/output_tokens). Line 411 reads normalizeTokenUsage(parsed?.usage) which is undefined for this shape; _usageFieldAliases (lines 55-62) traverse relative to the passed usage object and have no ['response',...] path, and the value passed is parsed?.usage anyway, so usage is null and no usage event is emitted. The openai/anthropic/amp families fall through to this shared normalizer (lines 424-444 only special-case pi/claude-code/gemini/antigravity/codex). The code is clearly designed to handle Responses events (response.started, response.output_text.delta, response.reasoning.delta, response.completed all appear), and the same branch's text extraction (extractGenericMessageText line 159) DOES look under parsed.response while the usage extraction does not - a clear internal asymmetry. Result: token/cost accounting silently dropped for the openai-family terminal event. Real correctness/data-loss bug; severity medium (no crash, accounting loss).

### 44. [MEDIUM · correctness] `apps/observability/src/metrics/trackEvent.js:299`

**SandboxFailed never decrements the sandboxActive gauge, causing permanent upward drift**

`SandboxCreated` increments the `sandboxActive` gauge: `Metric.incrementBy(event.runtime ? Metric.tagged(sandboxActive, "runtime", event.runtime) : sandboxActive, 1)` (line 274), and `SandboxCompleted` symmetrically decrements it by -1 (line 295). But the `SandboxFailed` handler only increments `errorsTotal`:

```
case "SandboxFailed":
    return Effect.all([
        countEvent,
        Metric.increment(errorsTotal),
    ], { discard: true });
```

In packages/sandbox/src/execute.js the lifecycle emits `SandboxCreated` (line 405, inside the try) and on any failure the catch block emits `SandboxFailed` (line 757). So every sandbox that fails leaves its +1 on `sandboxActive` un-cancelled. Over time the `smithers.sandbox.active` gauge drifts upward by one per failed sandbox and never returns to zero, making the 'currently active sandboxes' metric monotonically wrong (e.g. dashboards/alerts on active sandboxes report phantom running sandboxes). The `SandboxFailed` event carries a `runtime` field (verified in SmithersEvent.ts:213), so the decrement can be tagged identically to the create path.

**Fix:** Mirror the SandboxCompleted decrement in the SandboxFailed case: `Metric.incrementBy(event.runtime ? Metric.tagged(sandboxActive, "runtime", event.runtime) : sandboxActive, -1)` alongside the errorsTotal increment.

*Verifier:* Confirmed. sandboxActive is a Metric.gauge (apps/observability/src/metrics/sandboxActive.js:2). SandboxCreated increments it +1 (trackEvent.js:274) and SandboxCompleted decrements it -1 (trackEvent.js:295), but the SandboxFailed handler (trackEvent.js:299-303) only does countEvent + Metric.increment(errorsTotal) with no sandboxActive decrement. In packages/sandbox/src/execute.js, SandboxCreated is emitted at line 406 inside the try block (try begins line 381), early in the lifecycle; SandboxCompleted is only emitted on success paths (547/725), while the catch block (742) emits SandboxFailed (757) and never SandboxCompleted. Therefore every sandbox that fails after creation leaves its +1 on the gauge un-cancelled, causing monotonic upward drift of smithers.sandbox.active. The SandboxFailed event also carries runtime (execute.js:760, runtime: selectedRuntime), so a tagged -1 decrement matching the create path is feasible. Genuine gauge-accuracy leak; medium severity since it corrupts a monitoring metric rather than affecting program correctness.

### 45. [MEDIUM · security] `apps/review/action/src/gateEvent.ts:66`

**issue_comment authorizes on commenter association but checks out untrusted fork head with a write-scoped token**

For `pull_request` events the gate explicitly skips forks ("fork pull requests are not reviewed"). For `issue_comment` there is no fork guard at all: it only verifies the COMMENTER's `author_association` is OWNER/MEMBER/COLLABORATOR. runAction then runs `execFileSync("gh", ["pr", "checkout", String(decision.prNumber)], ...)` which checks out the PR *head* — which may be a fork branch authored by an untrusted, non-collaborator user — and proceeds to run agents with `GH_TOKEN` (write-capable in issue_comment context) and the session token present in env. A collaborator typing "@smithers review" on an attacker's fork PR causes untrusted code/content to be processed with write credentials in scope (classic pwn-request shape). The trust gate checks the commenter, not the code author.

**Fix:** For issue_comment, resolve the PR via gh and apply the same head-vs-base full_name fork check used for pull_request; refuse (or run in a restricted/read-only mode) when the PR head is a fork.

*Verifier:* Confirmed in real code. gateEvent.ts lines 47-57 apply a fork guard ('fork pull requests are not reviewed') ONLY to the pull_request branch (computing headFull vs baseFull full_name), with the documented rationale that forks have read-only tokens/no secrets. The issue_comment branch (lines 66-89) has no fork guard whatsoever: it gates solely on comment-on-PR, body startsWith '@smithers review', and author_association in {OWNER,MEMBER,COLLABORATOR} — i.e. it trusts the COMMENTER, never the PR author/code source. runAction.ts lines 73-79 then run execFileSync('gh', ['pr','checkout', prNumber], {env:{...GH_TOKEN}}) for issue_comment, checking out the PR head (a fork branch for fork PRs), and runReview (lines 99-107) executes the agents with GH_TOKEN and the session token in env. action.yml sets GH_TOKEN: github.token, which is write-capable in issue_comment (base-repo) context, and createSession.ts forwards only oidcToken+pr so the server cannot enforce a fork check either. This is the classic pwn-request trust-boundary defect: untrusted fork content processed with write credentials, gated on the commenter not the code author. Severity medium: a collaborator must type the trigger (partial human-in-the-loop mitigation), and full exploit impact depends on the review agents' tool/code-execution surface, but the structural weakness and asymmetry with the deliberately-guarded pull_request path are unambiguous.

### 46. [MEDIUM · correctness] `apps/review/src/diffs/renderFallbackDiffHtml.ts:47`  _(corroborated ×2)_

**Fallback diff renderer silently drops deleted/added lines whose content starts with '-- ' or '++ '**

In renderFallbackDiffHtml the global header-prefix skip runs BEFORE the +/-/context classification:

```
if (skippedPrefixes.some((prefix) => line.startsWith(prefix))) continue;
...
if (line.startsWith("+")) { ... } else if (line.startsWith("-")) { ... }
```

skippedPrefixes includes `"--- "` and `"+++ "` (the unified-diff file headers). But these prefixes are also matched by ordinary hunk-body lines, because a deleted line's raw form is `"-" + content` and an added line's is `"+" + content`. A deleted line whose content begins with `"-- "` (e.g. a SQL/Lua/Haskell/Ada comment `-- foo`, or a CLI flag line) produces the raw line `"--- foo"`, which `startsWith("--- ")` is true, so the line is `continue`d and never rendered. Likewise an added line whose content begins with `"++ "` produces `"+++ ..."` and is dropped. I verified both reach the skip branch. The result: real removed/added code lines silently vanish from the rendered diff (and the deletion is not counted, but the line-number counter is not advanced either, so subsequent line numbers in that hunk are off by the number of dropped lines). This is the display the human reviewer reads, so a reviewer can miss a deleted comment or see misnumbered lines.

**Fix:** Classify hunk-body lines before applying header skips: only apply the skippedPrefixes filter when outside a hunk (e.g. when `oldLine === 0 && newLine === 0`), or move the `@@`/`+`/`-`/context handling ahead of the skippedPrefixes check so that once a hunk has started, `--- `/`+++ ` are treated as del/add body lines.

*Verifier:* Lines 47 vs 49-54: the skippedPrefixes check (including "--- " and "+++ ") runs before +/-/context classification. A deleted line whose content begins with "-- " (e.g. a SQL/Lua/Haskell/Ada comment like `-- TODO`) becomes raw diff line `"-" + "-- TODO"` = `"--- TODO"`, which startsWith("--- ") is true, so line 47 `continue`s and the line is never rendered. Added lines with content `"++ ..."` become `"+++ ..."` and match `"+++ "`. Because the skip uses `continue` before oldLine/newLine increment, the line-number counters are not advanced, so subsequent lines in the hunk are misnumbered. SQL/Lua/Haskell `-- ` comments are a common real case, so genuine deleted code can vanish from the reviewer-facing diff. Real correctness defect; medium is appropriate since this is a display-only walkthrough renderer.

### 47. [MEDIUM · concurrency] `apps/review/src/server/proxy/handleAnthropic.ts:89`

**Per-session spend cap is enforced against a stale snapshot, so concurrent proxied calls can overspend the cap**

The spend cap is checked once, against the `spent_usd` value read at auth time: `spentUsd = auth.spentUsd; if (spentUsd >= spendCapUsd) return jsonError(402, ...)` (lines 88-91). The actual debit happens asynchronously after the response streams, via `deps.waitUntil(metering)` -> `recordUsage` which does `UPDATE sessions SET spent_usd = spent_usd + ?` (recordUsage.ts:40). Because the read-check and the write are not atomic and the write is deferred, N concurrent requests on the same session token all observe the same pre-debit `spent_usd`, all pass the `>= cap` gate, and all forward to Anthropic. A GitHub Action that parallelizes Anthropic calls (common for multi-file review) can therefore spend well beyond `spend_cap_usd` before the first debit lands. recordUsage's comment only justifies the single in-flight call crossing the cap; it does not address the concurrent-request case, which can blow the cap by an arbitrary multiple. The spend cap is the only financial guardrail for a session, so this is a real money-loss risk.

**Fix:** Enforce the cap atomically: do a conditional UPDATE (e.g. `UPDATE sessions SET spent_usd = spent_usd + ? WHERE hash = ? AND spent_usd < spend_cap_usd`) as a reservation before forwarding, or pre-reserve an estimated cost and reconcile after. At minimum bound per-session in-flight concurrency so the snapshot check cannot be raced by many simultaneous calls.

*Verifier:* Confirmed in code: authenticateProxyRequest.ts (lines 55-68) reads spent_usd from the DB into auth.spentUsd; handleAnthropic checks `if (spentUsd >= spendCapUsd)` pre-flight at line 89 against that snapshot; the actual debit is deferred to the metering promise handed to deps.waitUntil (line 144), which calls recordUsage doing `UPDATE sessions SET spent_usd = spent_usd + ?` (recordUsage.ts:39-42). There is no atomic check-and-debit and no other financial guard, so concurrent requests sharing a session token all observe the same pre-debit value and all pass the gate, allowing the cap to be exceeded by a multiple. The recordUsage comment only justifies a single in-flight call crossing the cap, not the concurrent case. This is a genuine money-overspend gap, though it is an inherent eventual-consistency tradeoff so severity is medium rather than high.

### 48. [MEDIUM · correctness] `apps/review/src/server/sessions/fetchJwks.ts:24`  _(corroborated ×3)_

**JWKS cache never refreshes on unknown-kid or empty-keys, so GitHub key rotation 401s legitimate tokens for up to 10 minutes**

fetchJwks caches the JWKS for CACHE_TTL_MS (10 min) keyed by url: `if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.keys;`. verifyOidc looks up the signing key with `const match = keys.find((k) => k.kid === header.kid); if (!match) return { ok: false, reason: 'unknown-key' };` and never busts the cache on a miss. GitHub Actions rotates its OIDC signing keys; when a token arrives signed with a kid not in the cached set, every request fails with 401 unknown-key until the 10-minute TTL elapses, even though the live JWKS already contains the key. This is compounded by fetchJwks caching an empty array: `const keys = Array.isArray(body.keys) ? body.keys : []; jwksCache.set(url, { fetchedAt: now, keys });` — a single malformed/empty discovery response pins `[]` for 10 minutes so ALL token verifications fail. The standard pattern is to re-fetch (cache-bust) once on a kid miss before declaring unknown-key.

**Fix:** On a kid lookup miss in verifyOidc, force a single cache-bypassing re-fetch of the JWKS and retry the match before returning unknown-key. Also avoid caching an empty keys array (or cache it with a much shorter TTL).

*Verifier:* Cache is keyed by url with 10-min TTL (line 3, 24-25) and is never busted on a kid miss: verifyOidc does keys.find(k=>k.kid===header.kid); if(!match) return unknown-key (verifyOidc.ts:104-105) with no re-fetch. Also fetchJwks caches an empty array when body.keys is missing/non-array (line 31-32: `Array.isArray(body.keys) ? body.keys : []` then jwksCache.set), pinning [] for 10 minutes. During a GitHub OIDC key rotation or a single malformed discovery response, valid tokens get 401 until TTL elapses. Real correctness defect; impact bounded to the ~10-min window and rotation is infrequent, hence medium/medium confidence rather than high.

### 49. [MEDIUM · concurrency] `apps/review/src/server/sessions/handleSessions.ts:93`

**checkQuota then mintSession is a non-atomic check-then-act on the shared DB, allowing the monthly PR quota to be exceeded**

handleSessions calls `const quota = await checkQuota(...)` (which does `SELECT COUNT(*) ... FROM reviewed_prs`) and only later `await mintSession(...)` which does `INSERT OR IGNORE INTO reviewed_prs`. There is no transaction or atomic counter spanning the read and the write (confirmed no batch/transaction usage in src/server). Two concurrent session requests for two DISTINCT new PRs of the same repo when `used === prsPerMonth - 1` will both read `used = prsPerMonth - 1`, both compute `overQuota = false`, and both insert their reviewed_prs row — letting the repo exceed its paid monthly quota by one (or more under higher concurrency). Since this gates billable inference (spend_cap sessions), it is a real metering/revenue defect, not just a display glitch.

**Fix:** Make the count+insert atomic: do the INSERT OR IGNORE first inside a transaction/batch and re-derive `used` from the row count in the same transaction, or enforce the cap with a conditional INSERT (e.g. INSERT ... SELECT ... WHERE (SELECT COUNT(*) ...) < prs_per_month) and treat zero changes as over-quota.

*Verifier:* Confirmed in code: checkQuota.ts performs pure reads (SELECT COUNT(*) FROM reviewed_prs ... and an existence SELECT 1), returning overQuota = !alreadyReviewed && used >= prsPerMonth. mintSession.ts later does INSERT OR IGNORE INTO reviewed_prs(repo, pr, month, ...). handleSessions.ts lines 93-111 call these sequentially with no wrapping transaction. grep over apps/review/src/server finds NO batch()/transaction/BEGIN usage anywhere (the only .exec match is a regexp on line 24). So two concurrent requests for two DISTINCT new PRs of the same repo when used === prsPerMonth - 1 both read used = prsPerMonth-1, both compute overQuota=false, and both insert distinct (repo,pr) rows (INSERT OR IGNORE only dedupes identical PRs, not distinct ones), exceeding the paid monthly quota. The minted session carries spend_cap_usd and gates billable inference, so this is a genuine metering/revenue defect, not cosmetic. Severity medium is right: the overage is bounded to the concurrency window (off-by-one per race at the boundary), not unbounded; the mintSession docstring even acknowledges the count-first ordering but does not address the cross-request race.

### 50. [MEDIUM · correctness] `apps/review/src/walkthrough/renderProse.ts:3`

**Inline markdown regexes run over already-emitted <code> spans, mangling code and producing crossing/invalid HTML tags**

renderInline applies three independent global regexes in sequence over the SAME string:

```
return escaped
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  .replace(/\*([^*]+)\*/g, "<em>$1</em>");
```

The bold/emphasis passes do not skip text that already became `<code>...</code>`. Because this renders a CODE-REVIEW document, inline code routinely contains `*` (pointers `*p`, globs `arr[*]`, multiplication `a*b*c`, etc.). Concrete failures:
- Input `` `a*b*c` `` -> after the code pass `<code>a*b*c</code>`, the emphasis pass matches the `*b*` INSIDE the code span and emits `<code>a<em>b</em>c</code>`, italicizing part of a code token.
- Input `` `a* b` and *c* `` -> the emphasis regex spans from the `*` inside the code element to the later `*`, producing `<code>a<em> b</code> and </em>c*` — crossing/overlapping `<code>`/`<em>` tags, i.e. structurally invalid HTML that browsers silently reparse, visibly corrupting the rendered prose.
Reviewers therefore see misformatted/garbled code in the narrated explanation. Note escaping is intact (no XSS), this is a formatting-correctness bug.

**Fix:** Tokenize inline code first: pull `` `...` `` matches out into placeholders, run bold/emphasis on the remainder, then substitute the escaped code spans back. Alternatively make the bold/emphasis regexes refuse to match across `<code>...</code>` boundaries (e.g. split on code spans and only transform the non-code segments).

*Verifier:* Confirmed in apps/review/src/walkthrough/renderProse.ts lines 4-7: renderInline chains three global regexes (.replace code, then strong, then em) over the same string. escapeHtml (escapeHtml.ts) only escapes &<>"' and leaves backticks and asterisks intact, so the code/em passes see raw `*`. Trace: input `` `a*b*c` `` -> code pass yields `<code>a*b*c</code>`; the em regex /\*([^*]+)\*/g then matches `*b*` inside the span -> `<code>a<em>b</em>c</code>`, italicizing part of a code token. For `` `a* b` and *c* `` -> code pass yields `<code>a* b</code> and *c*`; em pass spans from the `*` inside <code> to the later `*` -> `<code>a<em> b</code> and </em>c*`, crossing/invalid tags. Reachable because this renders code-review narrator prose where inline code with `*` is common. Escaping is intact so no XSS; this is a genuine formatting-correctness defect.

### 51. [MEDIUM · correctness] `packages/accounts/src/accountsRoot.js:15`

**accountsRoot uses ?? instead of || for HOME, so empty HOME yields a cwd-relative secrets path**

`return join(env.HOME ?? homedir(), ".smithers");` uses nullish coalescing, which only falls back to `homedir()` when `HOME` is `undefined`/`null`. If `HOME` is set to an empty string (common in some systemd units, minimal Docker/sandbox shells, and certain CI runners), `env.HOME` is `""`, which is NOT nullish, so `join("", ".smithers")` returns the RELATIVE path `".smithers"`. Every consumer (`accountsFilePath`, `readAccounts`, `writeAccounts`, `withAccountsLock`, `defaultConfigDir`) then resolves against the current working directory. Concrete impact: API keys (written mode 0600 by `writeAccounts`) land in `./.smithers/accounts.json` of whatever dir the process runs from instead of the user home; accounts "vanish" when cwd changes, and locks/temp files are created in the project tree. The rest of the codebase deliberately guards this case with `||` (see packages/agents/src/diagnostics/getDiagnosticStrategy.js:140 `env.HOME?.trim() || homedir()` and :276), confirming empty/whitespace HOME is an expected input that `??` mishandles.

**Fix:** Use `||` (and ideally trim) like the rest of the codebase: `return join((env.HOME && env.HOME.trim()) || homedir(), ".smithers");`

*Verifier:* accountsRoot.js:15 is `return join(env.HOME ?? homedir(), ".smithers");`. `??` falls back only on null/undefined, so an empty-string HOME passes through. Verified `path.join("", ".smithers")` returns the relative `".smithers"`, so with HOME="" and no SMITHERS_HOME, accountsRoot yields a cwd-relative path. Consumers accountsFilePath.js:11 and defaultConfigDir.js:28 resolve against it, so accounts.json (and locks/temp files) would be written under the current directory rather than home. The codebase elsewhere guards exactly this with `env.HOME?.trim() || homedir()` (packages/agents/src/diagnostics/getDiagnosticStrategy.js:139 and :276), confirming empty/whitespace HOME is an expected input that `??` mishandles. Empty HOME is an uncommon-but-real edge (some CI/sandbox/systemd shells), so medium severity is warranted.

### 52. [MEDIUM · logic] `packages/agents/src/agent-contract/renderSmithersAgentPromptGuidance.js:9`

**admin-category tools are silently dropped from prompt guidance despite "only rely on tools listed here"**

`PROMPT_CATEGORY_ORDER` is `["workflows","runs","approvals","debug"]` and deliberately omits `"admin"`. The render loop only iterates over `PROMPT_CATEGORY_ORDER` (`for (const category of PROMPT_CATEGORY_ORDER)`), so every tool whose category is `admin` is never listed in `promptGuidance`. Yet `inferCategory` in createSmithersAgentContract.js routes ALL `memory_*` and `cron_*` tools, and crucially its final fallback (`return "admin";`) routes EVERY unknown/new tool name, into `admin`. Meanwhile the prompt explicitly tells the agent: "Only rely on the tool names listed here." The net effect: live MCP tools that are actually available (e.g. `memory_query`, `cron_list`, or any tool added to the server but not in the hardcoded WORKFLOW/RUN/APPROVAL/DEBUG name sets) are present in `contract.tools` but invisible to the agent, so the agent is instructed never to use them. The presence of an unused `CATEGORY_LABELS.admin` ("administration and maintenance") strongly indicates admin was intended to be rendered and was omitted from `PROMPT_CATEGORY_ORDER` by mistake. Non-destructive admin tools (e.g. `memory_query`) get no mention at all (only destructive ones leak through the separate destructive-tools line).

**Fix:** Add "admin" to PROMPT_CATEGORY_ORDER (it is already in TOOL_CATEGORY_ORDER and has a CATEGORY_LABELS entry), so admin/unknown tools surfaced in the live contract are also listed in the prompt guidance.

*Verifier:* Confirmed real and reproduced. renderSmithersAgentPromptGuidance.js line 9 PROMPT_CATEGORY_ORDER=["workflows","runs","approvals","debug"] omits "admin"; the render loop (line 69) iterates only PROMPT_CATEGORY_ORDER, so admin-category tools never appear in promptGuidance, while line 67 tells the agent 'Only rely on the tool names listed here.' inferCategory in createSmithersAgentContract.js falls back to 'admin' for any name not in the hardcoded WORKFLOW/RUN/APPROVAL/DEBUG sets (lines 123,125). I fed the ACTUAL live semantic MCP tool list (from apps/cli/src/mcp/SemanticToolName.ts, served via client.listTools() in apps/cli/src/ask.js:426 and packages/pi-plugin/src/extension.ts:140) into createSmithersAgentContract and ran it: 7 real tools — fork_run, replay_run, rewind_run, restore_checkpoint, list_snapshots, get_timeline, time_travel — get categorized 'admin' (because the hardcoded DEBUG/DESTRUCTIVE sets use legacy names like 'fork','replay','timeline','timetravel' that don't match the live 'fork_run','replay_run','get_timeline','time_travel') and are entirely absent from promptGuidance. They are also not destructive-matched, so they appear nowhere. The agent is thus told these real, available time-travel/snapshot tools don't exist. The existing test (agent-contract.test.js) only asserts no STALE mentions, never that all provided tools are mentioned, so the gap is uncaught. The claim's specific memory_/cron_ examples aren't in the current semantic surface, but the mechanism and real-world impact are confirmed on actual tools. Severity medium: an entire time-travel/snapshot feature surface is silently hidden from agent guidance; not a crash or data loss.

### 53. [MEDIUM · error-handling] `packages/agents/src/AmpAgent.js:167`

**Amp failure result loses error message and leaks it into `answer`**

In the `result` handler:
```js
const ok = payload.is_error !== true;
return [{
  type: "completed",
  ok,
  answer: finalAnswer || asString(payload.result),
  error: ok ? undefined : asString(payload.error),
  ...
}];
```
When an Amp run fails (`is_error === true`), `error` is set from `payload.error` with no fallback, while `answer` is still populated from `finalAnswer || payload.result`. Amp emits the claude-code-style stream-json format (same `--stream-json` protocol the repo's own `ClaudeCodeAgent` parses), and in that format the failure text lives in `payload.result`, not `payload.error`. The proven sibling handler in `ClaudeCodeAgent.js` (lines 305-318) handles this correctly: on error it sets `answer: undefined` and `error: resultError || "Claude run failed"` (a guaranteed non-empty message). AmpAgent instead produces a `completed` event with `ok:false`, `error: undefined` (error reason lost — the engine records a failure with no diagnostic detail), and `answer` set to the error text (a failed step surfaces a misleading non-empty answer). Note the `onExit` path right below it DOES provide a fallback (`result.stderr.trim() || 'Amp exited with code …'`), so the gap is specific to the JSON result path.

**Fix:** Mirror ClaudeCodeAgent: `const ok = payload.is_error !== true; answer: ok ? (finalAnswer || asString(payload.result)) : undefined, error: ok ? undefined : (asString(payload.error) || asString(payload.result) || 'Amp run failed')`.

*Verifier:* Confirmed at AmpAgent.js lines 161-167. On a failed result (is_error===true, ok=false): (1) `answer: finalAnswer || asString(payload.result)` is still populated, so when finalAnswer is empty the error text from payload.result leaks into answer, surfacing a misleading non-empty answer for a failed step; (2) `error: ok ? undefined : asString(payload.error)` has no fallback, so if payload.error is absent/empty the error is undefined and the failure diagnostic is lost. The proven sibling ClaudeCodeAgent.js (lines 313-315) parses the same claude-code stream-json result format and handles it correctly: `answer: !isError ? ... : undefined` and `error: isError ? resultError || "Claude run failed" : undefined` (guaranteed non-empty). The onExit path in AmpAgent (lines 186-187) also provides a fallback, confirming the JSON-result path is the inconsistent one. Real error-handling defect, but moderate impact since the run is still correctly marked ok:false.

### 54. [MEDIUM · correctness] `packages/agents/src/BaseCliAgent/BaseCliAgent.js:444`

**asyncIterableToStream lets ReadableStream start() drain the generator before async-iteration consumers read it**

`asyncIterableToStream` constructs a `ReadableStream` whose `start(controller)` eagerly iterates the source generator (`for await (const item of iterable)`), and then reassigns `stream[Symbol.asyncIterator] = iterable[Symbol.asyncIterator].bind(iterable)`. For an async generator, `Symbol.asyncIterator` returns the SAME generator instance, so the async-iteration path shares one underlying generator with the `start()` pump. `start()` runs eagerly at construction time and advances over microtasks; by the time `buildStreamResult` has been returned through `Effect.map`/`runAgentPromise` and a caller does `for await (const part of result.textStream)` / `result.fullStream`, the generator has already been (partly or fully) consumed by `start()`. The async-iteration consumer therefore receives nothing or only an interleaved subset of chunks. Concretely, in `buildStreamResult` the `fullStream` generator yields `text-start`, `text-delta`, `text-end`; a `for await` consumer can miss the `text-delta` (the actual model text) or get an empty stream entirely, even though `result.text` (a separate `Promise.resolve(text)`) is correct. This corrupts the streamed output of `BaseCliAgent.stream()` for any consumer that iterates the stream (the documented common usage of the AI SDK `textStream`/`fullStream`).

**Fix:** Do not reassign Symbol.asyncIterator to the already-consumed generator. Either rely on the native ReadableStream async iterator (which reads from the buffered queue filled by start()), or make Symbol.asyncIterator a factory that returns a fresh iterator over a re-buildable source rather than the single generator instance that start() is draining.

*Verifier:* Empirically reproduced in bun: asyncIterableToStream sets stream[Symbol.asyncIterator] to the async generator's OWN iterator (gen[Symbol.asyncIterator]() returns the same generator), while ReadableStream.start()'s `for await (const item of iterable)` eagerly drains that same generator with no backpressure check. Both compete for gen.next(). After the microtask delay introduced by Effect.runPromiseExit/.map/await in stream(), start() has fully drained the generator, so a consumer doing `for await (const part of result.fullStream)` receives [] (verified: 'consumer received parts: []'). This corrupts the StreamTextResult.textStream/fullStream contract for any for-await consumer. Note the only producer is BaseCliAgent.stream() (line 1270) and the engine does not iterate CLI-agent streams internally (no .stream() callers in engine/driver), so internal impact is limited, but the documented AI-SDK for-await usage is genuinely broken. Severity medium, not higher, due to limited internal consumption.

### 55. [MEDIUM · performance] `packages/agents/src/BaseCliAgent/BaseCliAgent.js:922`

**launchDiagnostics fires provider API probes on EVERY invocation, even successful ones**

`diagnosticsPromise = launchDiagnostics(commandSpec.command, commandEnv, cwd, ...)` (line 922) is invoked unconditionally before `runCommandEffect`, but its result is only ever consumed in the `Effect.tapError` failure path (lines 1112-1124). On the success path the promise still resolves and is discarded — but the probes have already executed. For claude that means a `POST https://api.anthropic.com/v1/messages/count_tokens` per generate (claudeRateLimitCheck, getDiagnosticStrategy.js:172), for codex/openai a `GET /v1/models`, for google a `GET /v1beta/models`, plus a `spawnSync("which", ...)` (getDiagnosticStrategy.js:32) — every single agent step. In a workflow running thousands of agent calls this is thousands of redundant outbound requests; worse, the rate-limit probe consumes a request against the very rate limit it is meant to check, and sends the provider API key out on each call.

**Fix:** Launch diagnostics lazily only when an error occurs (inside tapError), or memoize/throttle the report per agent so it is computed at most once per run rather than per invocation.

*Verifier:* Confirmed. launchDiagnostics is called unconditionally at line 922 inside the flatMap before runCommandEffect. launchDiagnostics (launchDiagnostics.js) immediately calls runDiagnostics, which executes ALL checks eagerly via Promise.all(strategy.checks.map(runCheck)) the moment it is invoked. diagnosticsPromise is only ever read inside Effect.tapError (lines 1112-1124), so on the success path the probes have already executed and the result is discarded. checkCliInstalled unconditionally runs spawnSync('which', [command]) plus credential file reads on every invocation. For API-key-configured agents the network probes fire on every invocation: claude count_tokens (gated on ANTHROPIC_API_KEY, getDiagnosticStrategy.js:162-172), openai/codex GET /v1/models (lines 367,430), google GET /v1beta/models (lines 513,578) — including the rate-limit probe that consumes a request and sends the API key. The claim slightly overstates: in subscription/no-key mode the network calls return status 'skip' (lines 73,166,419,569), so only spawnSync+file reads run there. Core defect (eager diagnostics on every step, wasted on successes; redundant probes/key-sends for API-key agents) is real. Medium/performance is appropriate.

### 56. [MEDIUM · logic] `packages/agents/src/BaseCliAgent/createAgentStdoutTextEmitter.js:106`

**Overlapping if-blocks double/triple-emit top-level assistant message text**

In extractCliStreamTextChunks the assistant-message branches are independent `if`s (no `else`/return) and overlap. For a top-level `{type:"message", role:"assistant", content:"..."}` line (a real shape, cf. extract-usage.test.js:53) parsed in json/stream-json mode: line 103 `type === "message" && record.role === "assistant"` calls emitFinal; line 106 `upperType === "MESSAGE"` ALSO fires because `"message".toUpperCase()==="MESSAGE"`, calling emitFinal again; line 114 `record.role === "assistant" && typeof record.content === "string"` calls emitFinal a third time. For an uppercase `{type:"MESSAGE",...}` (antigravity's shape, antigravity-support.test.js:114) lines 106+114 still double it. Unlike emitResult (line 63, which guards `text !== state.lastFinalText`), emitFinal (lines 45-51) has no self-dedup, so repeated emitFinal calls with the same text each push a chunk. Result: the assistant answer is streamed via onText (wired to options.onStdout in BaseCliAgent.js:855) 2-3x, persisted as duplicate NodeOutput and shown doubled in the TUI / `smithers chat` / gateway UI — exactly the failure the file's own comment (lines 52-59) describes for the result echo. Reachable for any CLI that emits a top-level role+string-content assistant event in json/stream-json output mode.

**Fix:** Make the assistant-message branches mutually exclusive (use `else if`, or guard line 106 with `type !== "message"`, and drop the redundant line 114 case), and/or add the same `text !== state.lastFinalText` self-dedup guard to emitFinal that emitResult already has.

*Verifier:* Confirmed in createAgentStdoutTextEmitter.js: lines 103, 106, 114 are independent if-blocks (no else/return). For a line {type:"message", role:"assistant", content:"<string>"} all three conditions match, and emitFinal (45-51) has NO self-dedup against lastFinalText (unlike emitResult at line 63 which guards text !== state.lastFinalText). First emitFinal pushes and resets sawDeltaSinceBoundary=false; the second and third emitFinal calls see sawDeltaSinceBoundary still false and push the same text again -> triple emit (double for uppercase MESSAGE, which only hits 106+114). Reachable: CodexAgent uses outputFormat:"stream-json" (CodexAgent.js:602) so push() routes lines through extractCliStreamTextChunks (the text path bypasses parsing only when outputFormat is undefined/"text"), and {type:"message",role:"assistant",content:"Hello world"} string content is the repo's documented Codex --json shape (extract-usage.test.js:53). The emitter is wired to options.onStdout (BaseCliAgent.js:855), so the answer is streamed 2-3x to the live TUI/chat/gateway display - exactly the doubling the file's own comment (52-59) warns about. No existing test covers the top-level message/MESSAGE string-content shape, so it is unguarded. Severity medium: it duplicates the live streamed text, though the canonical final answer is extracted via a separate interpreter.onStdoutLine path, so the 'duplicate persisted NodeOutput' impact is partially overstated. AntigravityAgent uses outputFormat:"text" (line 298) so it does NOT trigger this via the emitter, but Codex stream-json makes the defect real and reachable.

### 57. [MEDIUM · correctness] `packages/agents/src/BaseCliAgent/runRpcCommandEffect.js:189`

**Abort-before-start still writes the prompt to an already-killed child**

At lines 189-198 the code synchronously calls `onAbort()` when `signal?.aborted` is already true at start. `onAbort` -> `kill` -> `terminateChild()` (SIGTERM) and `handleError` (settles, resolves the Effect with failure). But execution then falls through to lines 351-355, which check `if (!child.stdin)` and then unconditionally `child.stdin.write(promptPayload)` into the child that was just terminated. There is no `settled` check before the write, so the prompt is written to a dying/dead process. Combined with the missing stdin 'error' listener (see other finding), this can raise an unhandled EPIPE. At minimum it does pointless I/O against a process the caller already aborted.

**Fix:** After the abort wiring, return early if `settled` before attempting to send the prompt: `if (settled) return;` before the `child.stdin.write(promptPayload)` block.

*Verifier:* At lines 189-191, when signal is already aborted at start, onAbort()->kill()->terminateChild()+handleError() runs synchronously and sets settled=true, resolving the Effect with failure. Control then falls through to lines 350-355 which only check `if (!child.stdin)` (the stream object still exists after SIGTERM) and unconditionally write the prompt payload to the dying child. No `settled` check guards the write. This is redundant I/O against an already-aborted/terminated process and, combined with [0], a path to an unhandled EPIPE. Confirmed.

### 58. [MEDIUM · error-handling] `packages/agents/src/BaseCliAgent/runRpcCommandEffect.js:340`

**Agent killed by an external signal is reported as a successful completion**

In the close handler, `if (code && code !== 0)` treats only positive exit codes as failure. When a process is terminated by a signal (OOM killer, external `kill`, segfault), Node reports `code === null` (the signal name is the ignored 2nd argument). `null && ...` is falsy, so the code skips the error branch and proceeds to `finalize(text ?? "", ...)` at line 348, returning success with whatever partial or empty text was streamed. The caller then believes the agent completed normally and proceeds with truncated/empty output. (Self-inflicted kills via timeout/abort set `settled` first and return early at line 334, so only external signal deaths hit this path.)

**Fix:** Capture the signal arg: `child.on('close', (code, sig) => { ... })` and treat `code === null && sig` as a failure, e.g. `handleError(makeAgentCliError(stderr.trim() || \`CLI killed by signal ${sig}\`))`.

*Verifier:* Close handler at 330 binds only `code`; the signal name (2nd arg) is ignored. A process killed by an external signal (OOM, SIGKILL, segfault) yields code===null, so `if (code && code !== 0)` (340) is falsy and the error branch is skipped, falling to finalize(text ?? '', ...) at 348 = reported success with partial/empty streamed text. Self-inflicted kills set settled=true first (kill->handleError) and return early at 334, so only external signal deaths reach this path, exactly as claimed. The code cannot distinguish a clean exit-0 from an external signal kill. Real error-handling defect.

### 59. [MEDIUM · correctness] `packages/agents/src/ClaudeCodeAgent.js:459`

**Durability hook emits a second --settings that clobbers user-provided opts.settings**

When `opts.settings` is set, `buildCommand` pushes it at line 431 (`pushFlag(args, "--settings", this.opts.settings)`). Later, when durability is enabled, it pushes a SECOND `--settings` with the snapshot-hook JSON: `args.push("--settings", JSON.stringify({ hooks: { PostToolUse: [...] } }))`. The Claude CLI's `--settings` is a single-value option, so passing it twice means the last value wins — the durability JSON (pushed second) overrides and silently drops the user's `opts.settings` (which may carry their own hooks, permissions, model overrides, etc.). The inline comment claims this is "additive --settings", but two separate `--settings` flags are not merged by the CLI; only one is loaded. So enabling durability snapshots silently disables any user-supplied settings. The existing test (claude-support.test.js:94) only checks that one `--settings` is present and never exercises the both-set case, so the regression is uncaught.

**Fix:** Merge the two settings into a single `--settings` value before pushing. Parse/object-merge `this.opts.settings` (if it is a JSON string or read the file) with the durability hooks object and emit one combined `--settings` JSON, or push only the durability settings when `opts.settings` is absent and otherwise deep-merge the hooks into the user object.

*Verifier:* Confirmed in source: buildCommand line 431 `pushFlag(args, "--settings", this.opts.settings)` emits the user's settings, then line 459 `args.push("--settings", JSON.stringify({ hooks: { PostToolUse: [...] } }))` emits a SECOND --settings for the durability snapshot hook, pushed after. Claude CLI's --settings is a single-value commander option (repeated non-variadic flags = last value wins), so the durability JSON overrides and silently drops opts.settings (which could carry user hooks/permissions/model). The inline comment line 454 calls it 'additive --settings' which is wrong; the two flags are not merged by the CLI. The existing test (claude-support.test.js:80-104) uses indexOf('--settings') finding only the first occurrence and never sets opts.settings together with durability, so the regression is uncaught. Real defect, but narrow: requires durability snapshots enabled (feature-flag-gated, engine.js:3560/3611 sets durabilitySocket) AND a caller-supplied opts.settings, so medium severity rather than high. Confidence medium because the last-wins behavior depends on the Claude CLI's option parsing (commander), which I could not execute here but is well-established.

### 60. [MEDIUM · correctness] `packages/agents/src/diagnostics/getDiagnosticStrategy.js:118`

**api_key_valid prefix-only format check false-fails non-`sk-ant-` Anthropic keys (proxy keys, pi --api-key)**

`claudeApiKeyCheck` rejects any key not matching the `sk-ant-` prefix: `if (!apiKey.startsWith("sk-ant-")) { ... status: "fail", message: "ANTHROPIC_API_KEY has unexpected format ..." }` (line 118). For pi, `diagnosticApiKeyEnv` injects `ANTHROPIC_API_KEY = hints.apiKey` from the `--api-key` flag for the anthropic provider, and Anthropic-compatible proxies/gateways routinely issue keys without the `sk-ant-` prefix. Because a failed check throws non-retryable `AGENT_CONFIG_INVALID` in preflight, a working pi/anthropic run authenticated with such a key is blocked solely on the cosmetic prefix heuristic. First-party Anthropic keys (`sk-ant-api03-`) and OAuth tokens (`sk-ant-oat01-`) both pass, so the false-fail only affects proxy/custom keys.

**Fix:** Downgrade the prefix mismatch to a non-blocking warn/skip, or skip the format gate when a base-URL override is set (it implies a non-first-party endpoint); rely on the live probe to determine validity rather than the prefix.

*Verifier:* Confirmed at line 118: claudeApiKeyCheck returns status:'fail' for any ANTHROPIC_API_KEY not starting with 'sk-ant-'. diagnosticApiKeyEnv (line 726-727) injects ANTHROPIC_API_KEY=hints.apiKey for pi/anthropic from --api-key, and claudeApiKeyCheck is also used directly for claude-code (claudeStrategy.checks). A 'fail' status throws non-retryable AGENT_CONFIG_INVALID in preflight, blocking the run. The non-sk-ant proxy-key scenario is real in smithers: apps/review uses a session-scoped minted key over ANTHROPIC_BASE_URL (tests use 'srs_tok', clearly not sk-ant-prefixed), so a proxy/custom key gets blocked solely on the cosmetic prefix heuristic. First-party sk-ant-api03-/sk-ant-oat01- keys pass, so only proxy/custom keys are false-failed. Bumped from low to medium because it blocks smithers' own documented metered-proxy path; confidence medium since the exact minted-key format in production isn't fully verified.

### 61. [MEDIUM · api-misuse] `packages/agents/src/diagnostics/getDiagnosticStrategy.js:172`

**Claude (and Google) diagnostics ignore base-URL override, so preflight can hard-fail a valid proxy/gateway/test config**

`claudeRateLimitCheck` probes a hardcoded endpoint: `await fetch("https://api.anthropic.com/v1/messages/count_tokens", { headers: { "x-api-key": apiKey, ... } })` (line 172), and `googleAuthCheck`/`googleRateLimitCheck` likewise hardcode `https://generativelanguage.googleapis.com/...` (lines 513/578). The OpenAI path was explicitly fixed to honor `OPENAI_BASE_URL` (`openaiModelsUrl`, see commit "OpenAI diagnostics honor OPENAI_BASE_URL; chat-create e2e runs hermetically") for Azure/proxies/OpenAI-compatible gateways and hermetic test fixtures, but the Anthropic and Google checks have no `ANTHROPIC_BASE_URL` equivalent. When an agent is configured against an Anthropic-compatible proxy/gateway (a supported pattern the Anthropic SDK itself honors via `ANTHROPIC_BASE_URL`) with a proxy-issued key, the probe still hits `api.anthropic.com`, gets 401, and `rate_limit_status` returns `status:"fail"`. In `BaseCliAgent.preflight`, any failed check throws `AGENT_CONFIG_INVALID` with `failureRetryable:false`, so a configuration that would actually work is blocked outright (non-retryable). It also defeats hermetic test isolation for the Claude path the way the OpenAI fix achieved it.

**Fix:** Add an `anthropicBaseUrl(env)` helper mirroring `openaiModelsUrl` (default `https://api.anthropic.com`, honor `ANTHROPIC_BASE_URL`, strip trailing slashes) and build the count_tokens URL from it; do the same for the Google endpoints via a `GOOGLE_*`/`GEMINI_*` base-URL override.

*Verifier:* Confirmed at line 172: claudeRateLimitCheck does `fetch("https://api.anthropic.com/v1/messages/count_tokens", ...)` hardcoded, and googleAuthCheck/googleRateLimitCheck hardcode `https://generativelanguage.googleapis.com/v1beta/models` (lines 513/578). Only the OpenAI path resolves a base URL via openaiModelsUrl(env) honoring OPENAI_BASE_URL (lines 261-264). There is no ANTHROPIC_BASE_URL handling anywhere in packages (grep confirms only OPENAI_BASE_URL is read in this file). ANTHROPIC_BASE_URL is a real, supported proxy pattern in smithers itself: apps/review/src/workflow/createReviewAgents.ts:50-62 builds ClaudeCodeAgent API-key mode from ANTHROPIC_BASE_URL+ANTHROPIC_API_KEY (the metered-proxy cloud path). With an sk-ant-prefixed proxy key, claudeApiKeyCheck passes but claudeRateLimitCheck still probes real api.anthropic.com -> 401 -> status 'fail' -> preflight throws AGENT_CONFIG_INVALID failureRetryable:false (BaseCliAgent.js:1188, engine.js:3312-3314), blocking a config that would actually run. Also defeats hermetic test isolation for the Claude/Google paths the OpenAI fix enabled. Real inconsistency and real block.

### 62. [MEDIUM · api-misuse] `packages/agents/src/document-parsing/createDocumentParsingToolset.js:368`

**Firecrawl file/parse path sends invalid "text" format (not mapped like the scrape path)**

The two Firecrawl code paths handle `outputFormat === "text"` inconsistently. The URL/scrape path correctly maps text to a valid Firecrawl format: `formats: [input.outputFormat === "text" ? "markdown" : (input.outputFormat ?? "markdown")]` (line 109). But the file/parse path in `createFirecrawlOptions` does NOT map text: `formats: [input.outputFormat === "json" ? "json" : (input.outputFormat ?? "markdown")]` (line 368). When a caller passes a base64/text source with `outputFormat: "text"`, this produces `formats: ["text"]`. "text" is not a valid Firecrawl v2 format (valid values are markdown, html, rawHtml, json, links, screenshot, summary), so the Firecrawl `/parse` request is rejected with a 4xx and `postMultipart` throws `Document parsing provider failed`. A `parse_document` call that works for URLs fails for uploaded files with the same outputFormat.

**Fix:** Mirror the scrape path: `formats: [input.outputFormat === "text" || !input.outputFormat ? "markdown" : input.outputFormat]`, i.e. map "text" (and undefined) to "markdown" before building the parse options.

*Verifier:* Confirmed internal inconsistency. The URL/scrape path at line 109 deliberately maps outputFormat 'text' to a valid Firecrawl format: `formats: [input.outputFormat === "text" ? "markdown" : (input.outputFormat ?? "markdown")]`. The file/parse path's createFirecrawlOptions (line 368) does NOT: `formats: [input.outputFormat === "json" ? "json" : (input.outputFormat ?? "markdown")]`. So with a base64/text source and outputFormat:'text' (an allowed enum value per inputSchema line 39), createFirecrawlOptions emits `formats: ["text"]`. The code's own URL-path mapping is direct evidence the author knows 'text' is not a valid Firecrawl format; passing it to /parse would be rejected (4xx), and postMultipart (line 266-269) then throws 'Document parsing provider failed'. A parse that works for URLs fails for uploaded files with the same outputFormat. The 4xx rejection itself can't be confirmed offline, hence medium confidence, but the divergent handling of the identical enum value is plainly a real defect.

### 63. [MEDIUM · concurrency] `packages/agents/src/ForgeAgent.js:104`

**ForgeAgent stores per-call conversation id on shared instance state, corrupting resume tokens under concurrent reuse**

buildCommand sets mutable instance state: `this.issuedConversationId = resumeSession ?? this.opts.conversationId ?? randomUUID();` (line 104), and the output interpreter reads it lazily at event time: `resume: this.issuedConversationId` in onStdoutLine (line 61) and onExit (lines 70, 83). The interpreter closure is created per generate() call but it dereferences `this.issuedConversationId` only when the started/completed events fire (onExit at BaseCliAgent.js:947, after the child process finishes). Smithers commonly passes a single agent instance to multiple tasks. If two generate() calls run concurrently on the same ForgeAgent, call B's buildCommand overwrites `this.issuedConversationId` with idB before call A's process exits. Call A's spawned `forge` already baked `--conversation-id idA` into its argv (correct), but A's emitted `started`/`completed` events report `resume: idB`. The engine then records the wrong resume/conversation token for run A, so a later `--resume` resumes the wrong Forge conversation. Codex avoids this by keeping threadId in a per-call interpreter closure local (CodexAgent.js:78), confirming the safe pattern; Forge regresses it onto `this`.

**Fix:** Do not store the conversation id on the instance. Compute it inside buildCommand as a local, return it on the commandSpec, and have createOutputInterpreter receive/capture a per-call value (e.g. close over a local set when the interpreter is created for that call), mirroring how CodexAgent keeps `threadId` as a closure local.

*Verifier:* Confirmed in ForgeAgent.js: line 38 declares instance field issuedConversationId; line 104 buildCommand assigns this.issuedConversationId; lines 61/65/70/83 the per-call interpreter reads this.issuedConversationId LAZILY inside onStdoutLine/onExit. BaseCliAgent.js shows buildCommand (l.827) then createOutputInterpreter (l.857), and onExit fires only after the child exits (emitEvents(interpreter.onExit(result)) at l.947). The engine selects effectiveAgent = agents[index] (engine.js:3123) and runs tasks in parallel; seeded workflows define one agent instance and reuse it across tasks (e.g. const codex = new CodexAgent reused in .smithers/workflows/*.tsx), so concurrent reuse of a single Forge instance is normal usage. Under concurrency, call B's synchronous buildCommand overwrites this.issuedConversationId between call A's spawn and A's post-exit events, so A emits started/completed with B's id, recording the wrong resume/conversation token; a later --resume then resumes the wrong Forge conversation. CodexAgent (CodexAgent.js:78) keeps threadId closure-local, the safe pattern Forge fails to follow. Kimi/Vibe share the same this.issuedSessionId flaw, confirming it is a regression of the closure-local convention. Real correctness bug; medium because it requires concurrent reuse of the same (less common) Forge instance to manifest.

### 64. [MEDIUM · error-handling] `packages/agents/src/http/createHttpTool.js:133`

**JSON.parse on response body has no try/catch; malformed JSON crashes the tool**

In parseResponseBody, when the response Content-Type includes "application/json" the body is parsed with an unguarded `return JSON.parse(text);` (line 133). createHttpTool is explicitly built to call ANY REST API, so the response is fully controlled by a third-party server. A server that returns a `Content-Type: application/json` header but a malformed, truncated, or HTML error body (very common for gateways/proxies returning 502 pages with a wrong content-type) makes JSON.parse throw. The throw escapes through the `finally` in executeHttpRequest and rejects the tool's execute promise, so the agent gets a hard tool error instead of a structured HttpToolOutput. This defeats the whole purpose of a robust HTTP tool: `ok:false`/`status:502` responses become crashes rather than inspectable outputs.

**Fix:** Wrap the parse: `try { return JSON.parse(text); } catch { return text; }` so a malformed JSON body falls back to the raw text (the body field is typed `unknown` already), preserving status/headers for the caller.

*Verifier:* Line 133 `return JSON.parse(text)` in parseResponseBody is unguarded. executeHttpRequest awaits it at line 80 with only a `finally` (lines 82-86) that clears the timeout but does not catch. execute (line 37) wraps executeHttpRequest with no try/catch. So a third-party server returning Content-Type: application/json with a malformed/truncated/HTML body makes JSON.parse throw, rejecting the tool's execute promise instead of yielding a structured HttpToolOutput (e.g. ok:false/status:502). Genuine error-handling defect given the tool is built to call arbitrary REST APIs.

### 65. [MEDIUM · error-handling] `packages/agents/src/KimiAgent.js:178`

**Transient Kimi OAuth refresh failures (network/5xx) are classified as non-retryable**

In `refreshKimiTokenIfNeeded`, any failed refresh — including transient ones — is turned into a failure result: a 503/network blip raises `throw new Error(\`kimi oauth refresh failed (${tag})...\`)` (line 101) which is caught and returned as `{ ok: false, reason: ... }` (lines 130-132). `ensureKimiCredentialsUsable` then throws `new SmithersError("AGENT_CONFIG_INVALID", ..., { failureRetryable: false, ... })` (lines 178-186). `failureRetryable: false` is the engine's established non-retry signal (same flag set by `classifyNonRetryableAgentError`). So a transient HTTP 5xx, DNS failure, or timeout while contacting `auth.kimi.com` permanently fails the run and tells the user to `kimi login`, even though the stored refresh_token is perfectly valid and a retry seconds later would succeed. Transient infrastructure errors should stay retryable; only true permanent failures (invalid_grant/401, no refresh token) should be non-retryable.

**Fix:** Distinguish transient from permanent failures: only set `failureRetryable: false` for 401/invalid_grant and the no-refresh-token case; for network errors and 5xx responses, either let the run retry (throw a retryable error or simply return without failing fast so kimi attempts its own refresh) so a transient blip does not kill the run.

*Verifier:* Confirmed. refreshKimiTokenIfNeeded is only invoked when the token is within 60s of expiry (line 46 short-circuits otherwise). When a refresh attempt fails for ANY reason it returns {ok:false}: an HTTP 5xx hits lines 98-101 (throw `http-${status}`) caught at 130-132, and a network/DNS/timeout failure from fetch (line 93) throws and is caught at the same place. ensureKimiCredentialsUsable then throws SmithersError('AGENT_CONFIG_INVALID', ..., {failureRetryable:false}) at lines 178-186. engine.js:2328 and static-task-bridge.js:292 treat failureRetryable===false as a hard non-retry. So a transient 503/DNS blip while contacting auth.kimi.com permanently fails the run with a 'run kimi login' message even when the stored refresh_token is valid and a retry would succeed. There is no distinction between transient (5xx/network) and permanent (invalid_grant/401, no-refresh-token) causes.

### 66. [MEDIUM · resource-leak] `packages/agents/src/mcp/createMcpToolset.js:37`  _(corroborated ×2)_

**Spawned MCP server process leaks if listTools()/tool build throws after connect**

In createMcpToolset, after `await client.connect(transport)` succeeds (which spawns the child MCP server process), the code calls `const listed = await client.listTools();` and then iterates `listed.tools` without any try/catch. If `listTools()` rejects (server returns an error, protocol mismatch, timeout) — or if anything in the build loop throws — the rejection propagates to the caller and `client.close()` is NEVER called. The function never returns the McpToolset, so the caller also has no `close()` handle. The spawned server child process (and its stdio pipes) is leaked for the lifetime of the host process. Repeated failed connections (e.g. an agent retrying) accumulate orphaned processes.

**Fix:** Wrap everything after `await client.connect(transport)` in a try/catch that calls `await client.close()` (best-effort) before rethrowing, e.g. `try { const listed = await client.listTools(); ... return {...}; } catch (err) { try { await client.close(); } catch {} throw err; }`.

*Verifier:* Confirmed in createMcpToolset.js lines 34-48. client.connect(transport) calls the SDK's start() which spawns the child via cross_spawn and resolves on the 'spawn' event (verified in SDK 1.29.0 client/stdio.js), so the process is alive after connect. Lines 37-48 (listTools + build loop) have no try/catch. A rejecting listTools() (protocol mismatch/timeout/server error) or a throw in the loop propagates to the caller; client.close()—the only code that ends stdin and sends SIGTERM/SIGKILL—is never invoked, and the function never returns the toolset so the caller has no close() handle. The spawned MCP server child and its stdio pipes leak. Genuine resource leak on the error path.

### 67. [MEDIUM · correctness] `packages/agents/src/sanitizeForOpenAI.js:28`  _(corroborated ×2)_

**Record/map schemas (additionalProperties as a sub-schema) are silently overwritten to false, making the field uninhabited**

Rule 2 does `if (obj.type === "object" && obj.additionalProperties !== false) obj.additionalProperties = false;`. In JSON Schema `additionalProperties` may legitimately be a *schema object* (not just a boolean) — this is exactly what Zod v4 `z.toJSONSchema()` emits for `z.record(...)`/dictionary types, e.g. `{ type: "object", propertyNames: {...}, additionalProperties: { type: "number" } }`. Because the value schema `{ type: "number" }` is not strictly `=== false`, the condition fires and clobbers it to `false`. Combined with no `properties` (Rule 3 is skipped since `properties` is absent), the object becomes closed with zero allowed keys, so the model can only ever emit `{}`. A workflow output schema that uses a record field (this runs in CodexAgent.js:574 when `nativeStructuredOutput === true`) thus silently loses that field's contents — the agent can never return a non-empty map. The value schema is dropped without warning.

**Fix:** Only force `false` when `additionalProperties` is missing or already a boolean: `if (obj.type === "object" && obj.additionalProperties == null) obj.additionalProperties = false;` (or explicitly skip when `typeof obj.additionalProperties === "object"`), and recurse into the sub-schema instead of discarding it. If OpenAI strict mode truly cannot represent the record, surface an explicit error rather than silently producing an uninhabited object.

*Verifier:* Confirmed. Zod v4 z.toJSONSchema(z.record(z.string(), z.number())) emits {type:'object', propertyNames:{...}, additionalProperties:{type:'number'}}. Line 28 condition `obj.type === 'object' && obj.additionalProperties !== false` fires because the value schema object is not strictly ===false, so line 29 clobbers it to false BEFORE the recursion (line 41) ever runs. Ran sanitizeForOpenAI on the real output: the field becomes {type:'object', propertyNames:{...}, additionalProperties:false} with no `properties`, so Rule 3 is skipped and the model can only emit {}. The value schema is silently dropped. This is the live path used in CodexAgent.js:574 when nativeStructuredOutput===true (via z.toJSONSchema -> sanitizeForOpenAI). Genuine silent data loss for record/dictionary output fields. Note OpenAI strict mode doesn't support open records anyway, but the function silently degrades to an uninhabited field rather than preserving or warning, which matches the claim.

### 68. [MEDIUM · security] `packages/agents/src/transcription/createTranscriptionTool.js:101`

**Whisper path performs SSRF by fetching arbitrary model-supplied audioUrl server-side, leaking response bodies into errors**

`transcribeWithWhisper` does `const audioResponse = await fetchImpl(input.audioUrl)` where `input.audioUrl` comes straight from the tool input (the LLM/untrusted caller). There is no scheme/host validation, so a model can drive a server-side request to internal addresses (e.g. http://169.254.169.254/latest/meta-data/, http://localhost:..., file-like internal services). This is a classic SSRF. It is made worse by `assertOk(audioResponse, "download audio for Whisper transcription")` (line 102), which on a non-2xx reads `await response.text()` and embeds the internal endpoint's response body into the thrown Error message (lines 159-163), exposing internal response content back to the caller/logs. (The Deepgram path passes the URL to Deepgram instead of fetching it, so only the Whisper branch self-fetches.)

**Fix:** Validate input.audioUrl before fetching: require https (or http) scheme, reject non-public hosts (loopback, link-local 169.254.0.0/16, RFC1918, IPv6 ULA/link-local) after DNS resolution, optionally restrict to an allowlist. Do not include the downloaded body text in error messages for the audio-download step. Consider a max content-length / streaming cap to avoid unbounded memory use from `blob()`.

*Verifier:* Confirmed from the actual code. normalizeInput (line 67) takes audioUrl straight from tool input with only .trim(), no scheme/host validation. transcribeWithWhisper line 101 does `const audioResponse = await fetchImpl(input.audioUrl)` — a server-side fetch of a model/caller-supplied URL with no allowlist, scheme check, or private-IP/metadata-endpoint blocking, which is a textbook SSRF surface. line 102 then calls assertOk, and assertOk (lines 159-163) on a non-2xx does `await response.text()` and concatenates the internal endpoint's response body into the thrown Error message, leaking internal content back to the caller/logs. The Deepgram branch (lines 129-130) forwards the URL to Deepgram (JSON.stringify({url})) rather than self-fetching, confirming only the Whisper branch self-fetches. In an AI SDK tool, audioUrl is produced by the model at execution time and can be steered via prompt injection, so this is a reachable SSRF + info-leak. Severity medium is appropriate: it requires the model to be induced to call the tool with an internal URL, and the response is JSON-parsed/uploaded to Whisper rather than returned wholesale, but the error-path body leak and the bare server-side fetch are real defects.

### 69. [MEDIUM · logic] `packages/components/src/components/Optimizer.js:20`

**Optimizer ignores targetScore — early-stop on convergence never happens**

OptimizerProps documents `targetScore` as the "Score threshold to stop early" and the inline comment claims "the runtime re-renders and checks the evaluate output's `score` field against `targetScore` each frame." But `targetScore` is never destructured from `props` (line 20: `const { id, generator, evaluator, generateOutput, evaluateOutput, maxIterations = 10, onMaxReached = "return-last", children } = props;`) and is never used anywhere. The component never reads SmithersContext / the evaluate output, and the Loop is created with a hard-coded `until: false` (line 28). `Loop`/`Ralph` (Ralph.js) forwards `until` as a static boolean to `smithers:ralph`, so there is no mechanism by which the score is ever compared to the threshold. Consequence: the optimizer always burns all `maxIterations` even after it has converged, wasting agent calls/tokens, and the documented convergence feature silently does nothing.

**Fix:** Destructure `targetScore`, read the evaluate output via `React.useContext(SmithersContext)` + `ctx?.outputMaybe(evaluateOutput, { nodeId: evaluateId })`, and compute `until` dynamically (e.g. `until: typeof score === 'number' && targetScore != null && score >= targetScore`) so the loop exits once the threshold is met.

*Verifier:* Line 20 destructures props and omits targetScore; it is never referenced anywhere in Optimizer.js. Line 30 passes until:false unconditionally. Loop (Ralph.js lines 16-23) forwards `until` verbatim as a static boolean prop to smithers:ralph with no score-comparison mechanism. The component never reads SmithersContext or the evaluate output. The inline comment (lines 24-26) claims a per-frame score-vs-targetScore check that does not exist. OptimizerProps.ts line 15-16 documents targetScore as 'Score threshold to stop early', so the documented convergence/early-stop feature is silently a no-op and the loop always burns all maxIterations. Confirmed defect; impact is wasted agent calls/tokens, not a crash, so medium.

### 70. [MEDIUM · api-misuse] `packages/components/src/components/Optimizer.js:46`

**Compute-function evaluator never receives the generated candidate**

When `evaluator` is a function (`isAgentEvaluator === false`), the evaluate Task is built with `children: evaluator` and `needs: { candidate: generateId }` but NO `deps` and NO `agent` (lines 46-50). In Task.js, the function-children path only invokes children with resolved deps when `(agent || deps)` is set; with neither, it falls through to the compute branch (`__smithersComputeFn: children`). Every compute call site invokes the function with no arguments (`defaultTaskExecutor.js:12` `() => task.computeFn()`; engine.js:4021; compute-task-bridge.js:492). `needs` only creates dependency edges / context for agent prompts, it is not injected into a compute function's arguments. So an evaluator declared as `(candidate) => ({ score: candidate.x })` (per `OptimizerProps.evaluator` type) is called as `evaluator()` and receives `candidate === undefined`, producing a crash or a meaningless score. The candidate would only be passed if `deps` (not `needs`) were used, which routes through `children(resolvedDeps)` in Task.js.

**Fix:** For the function-evaluator branch, pass the candidate via `deps: { candidate: generateOutput }` (with matching `needs`) so Task.js calls `evaluator(resolvedDeps)`, or wrap it as `children: (deps) => evaluator(deps.candidate)` with `deps` set; do not rely on `needs` alone to feed a compute function.

*Verifier:* For the function-evaluator branch (Optimizer.js lines 46-51) the Task gets children:evaluator, needs:{candidate:generateId}, but no deps and no agent. In Task.js line 243 childValue = (typeof children==='function' && (agent||deps)) ? children(resolvedDeps) : children — with neither agent nor deps, childValue remains the raw function. agent is falsy so the agent branch is skipped; line 266 (typeof children==='function' && !deps) is true, routing to __smithersComputeFn: children (the raw evaluator). The engine invokes compute fns with no arguments: compute-task-bridge.js:492 `() => desc.computeFn()` and engine.js:4021, and the type is `computeFn?: () => unknown` (index.d.ts:3019). So an evaluator typed `(candidate)=>...` (OptimizerProps.ts line 10) is called as evaluator() with candidate===undefined, crashing or returning a meaningless score. needs alone (without deps) does not inject the value, and deriveDepNodeIds returns undefined when deps is absent so it does not even form the dependency edge here. Confirmed defect.

### 71. [MEDIUM · logic] `packages/components/src/components/Poller.js:33`

**Poller does not wait intervalMs between polls; it only sets the check task's timeoutMs**

`intervalMs`/`backoff` are documented as the delay "between polls", but `computeTimeoutMs(...)` is only applied as the check Task's `timeoutMs` (Poller.js:53,60). `timeoutMs` is an upper bound on how long the task may run, not a delay, and there is no Timer/sleep inserted between loop iterations (the Loop body contains only the check Task — confirmed no Timer/setTimeout/delay in the file). For a fast compute check (e.g. polling a file or HTTP status that returns immediately), the loop fires all `maxAttempts` (default 30) iterations back-to-back with zero spacing, hammering the polled resource and exhausting attempts in milliseconds. Exponential/linear backoff has no observable effect on poll spacing.

**Fix:** Insert an actual delay between iterations (e.g. wrap the check with a `<Timer duration={computeTimeoutMs(iteration, baseInterval, backoff)}>` or a wait node) instead of overloading the task `timeoutMs`, so the documented interval/backoff governs the gap between polls.

*Verifier:* Confirmed. Poller (Poller.js:53,60) only sets the check Task's `timeoutMs` to computeTimeoutMs(...). timeoutMs is a max-execution-duration bound (TaskProps.ts:46, grouped with heartbeatTimeout/heartbeatTimeoutMs), not a delay. The Loop component (Ralph.js:11-24) emits `smithers:ralph` with only the check Task as a child — there is no Timer/sleep/delay node anywhere in Poller.js or Loop. PollerProps.ts documents intervalMs as 'Base interval in milliseconds between polls' and backoff as 'Backoff strategy between polls', so the documented contract is delay-between-polls. For a fast compute check (immediate-return file/HTTP status), nothing enforces a minimum spacing, so the loop iterates back-to-back up to maxAttempts (default 30) and backoff has no observable effect on poll spacing. The code's own docstring (lines 7-12) even concedes it merely sets timeoutMs as a proxy. This is a genuine logic/semantics defect, not a misread. Severity medium: it causes a fast resource-hammering poll loop and renders intervalMs/backoff ineffective for compute checks, though it does not crash or corrupt data.

### 72. [MEDIUM · logic] `packages/components/src/components/ReviewLoop.js:36`

**ReviewLoop never terminates early on approval — runs all maxIterations regardless**

ReviewLoop renders `React.createElement(Loop, { id: prefix, until: false, maxIterations, onMaxReached })`. The component never reads `reviewOutput` from context, so `until` is the constant `false` on every re-render. The engine decides loop completion via `done.set(ralph.id, Boolean(ralph.until || st?.done))` (packages/engine/src/engine.js:2304), where `st.done` only becomes true when `maxIterations` is reached. There is no engine mechanism that inspects a loop child's `approved` field — the documented correct pattern (SmithersCtx.js:183-188) is that a loop `until` MUST be built by reading the child output (`ctx.latest(...)`), exactly as the sibling Poller component does. The in-code comment claiming "the runtime ... reads `reviewOutput` for the `approved` field" is false. Concrete impact: a producer→reviewer cycle that is approved on iteration 1 still runs the full `maxIterations` (default 5) of expensive producer+reviewer agent calls, wasting cost/time and ignoring the approval signal, contradicting the docstring "repeat until approved".

**Fix:** Read the review output reactively like Poller does: `const ctx = React.useContext(SmithersContext); const reviewRow = ctx?.latest(reviewOutput, reviewId); const approved = reviewRow?.approved === true;` and pass `until: approved` to Loop (resolving the iteration-scoped reviewId).

*Verifier:* ReviewLoop.js line 36 passes a hardcoded `until: false` to the Loop primitive. Unlike its sibling Poller.js (which calls `React.useContext(SmithersContext)` and computes `until = checkRow?.satisfied === true` via `ctx.outputMaybe(...)` each frame), ReviewLoop does NOT import or read SmithersContext at all, and never reads `reviewOutput`. The destructured `reviewOutput` (line 20) is only forwarded as the `output` target of the review Task (line 45), never inspected for an `approved` field. The Loop host element (Ralph.js) just forwards `until` to `smithers:ralph`. The engine's buildRalphDoneMap (engine.js ~2304) sets `done.set(ralph.id, Boolean(ralph.until || st?.done))`; `ralph.until` is the static `false`, and `st.done` only flips true at maxIterations. Grepping the engine/reconciler shows no mechanism that reads a loop child's `approved` output to terminate (all `approved` references concern human approval gates, not ReviewLoop). The in-code comment (lines 24-32) claiming 'the runtime ... reads reviewOutput for the approved field' is false. ReviewLoop is exported and used in seeded workflows. Net effect: an approved producer->reviewer cycle still runs all maxIterations (default 5) of expensive agent calls, contradicting the 'repeat until approved' docstring. Medium severity (cost/time waste, no crash/data loss).

### 73. [MEDIUM · logic] `packages/components/src/components/ScanFixVerify.js:48`

**ScanFixVerify loop never exits early when verification passes**

The inner Loop is created with `until: false` and the comment "Re-evaluated at render time via reactive context", but the component never reads `verifyOutput` (or any context) to compute `until`. As with ReviewLoop, the engine only ends the loop when `until` is truthy or `maxRetries` is hit (engine.js:2304; the correct dynamic-`until` pattern is documented at SmithersCtx.js:183-188 and implemented in Poller). Result: even if the verifier reports all issues resolved on cycle 1, the loop still runs the full `maxRetries` (default 3) scan→fix→verify cycles, each an expensive agent call, contradicting the docstring "repeating until verification passes".

**Fix:** Compute `until` from the verify output, e.g. read `ctx.latest(verifyOutput, "${prefix}-verify")` and set `until` true when the verifier reports all issues resolved.

*Verifier:* ScanFixVerify.js lines 46-51 pass `until: false` and the function (lines 11-61) never imports SmithersContext nor calls React.useContext, so it cannot reactively recompute `until` from verifyOutput. The correct dynamic pattern is in Poller.js lines 30-41/63-68 which reads ctx.outputMaybe(checkOutput) and sets until=checkRow.satisfied===true. Since ScanFixVerify's until is permanently false, the only termination is maxIterations (maxRetries default 3), so the loop runs all scan->fix->verify cycles even when verification passes on cycle 1, contradicting the docstring 'repeating until verification passes'. ReviewLoop.js has the identical defect.

### 74. [MEDIUM · correctness] `packages/components/src/components/SuperSmithers.js:48`  _(corroborated ×2)_

**SuperSmithers with a JSX/MDX strategy element produces an unrendered '[object Object]' prompt and throws**

When `strategy` is a React element (the documented `string | React.ReactElement` type), `readChildren` becomes a raw React Fragment (lines 45-47): `React.createElement(React.Fragment, null, strategyElement, React.createElement("p", ...))`. That Fragment is passed verbatim as the children of a raw `smithers:task` host element (lines 48-53) instead of being rendered to text. Unlike the `Task` component (which calls `renderPromptToText`), SuperSmithers bypasses Task entirely. At graph-extraction time the agent prompt is computed as `String(raw.children ?? "")` (packages/graph/src/dom/extract.js:793). `String(<Fragment>)` yields `"[object Object]"`, which the very next line (extract.js:794) rejects by throwing `MDX_PRELOAD_INACTIVE`. So any SuperSmithers invocation with a JSX/MDX strategy (e.g. the tested `strategy={<p>Use JSX strategy</p>}`) crashes the run with a misleading 'MDX preload not active' error, even when MDX preload is fine, because the root cause is the unrendered Fragment, not preload. The existing test only inspects the element tree (ids/outputs), not the extracted graph, so it misses this.

**Fix:** Render the strategy element to text before embedding it in the prompt: use `renderPromptToText` from Task.js (or compose via the `Task` component) so `readChildren` for the element case becomes a string prompt built from `renderPromptToText(strategyElement)` plus the target-files line.

*Verifier:* Confirmed. SuperSmithers.js:45-53 builds a raw 'smithers:task' host element with readChildren = React.createElement(React.Fragment, ...) when strategy is a React element, bypassing Task/renderPromptToText (which Debate.js and HumanTask.js use to render prompts to text). The reconciler stores rawProps verbatim (reconciler.js:60 `rawProps: props ?? {}`), so raw.children is the unrendered Fragment object. Graph extraction computes `const prompt = isAgent ? String(raw.children ?? '') : undefined` (extract.js:793), which for a React element object yields '[object Object]', and the very next line (794-797) throws SmithersError('MDX_PRELOAD_INACTIVE'). The JSX-strategy path is documented (type string|React.ReactElement) and exercised by the test (composite-coverage.test.jsx:592 `strategy: <p>Use JSX strategy</p>`), but that test only asserts on props.id/props.output of the element tree and never runs extraction, so it does not catch the crash. Misleading error since the cause is the unrendered Fragment, not MDX preload.

### 75. [MEDIUM · correctness] `packages/components/src/components/Supervisor.js:36`

**Supervisor worker/review/final tasks use `needs` without `deps`, so plan/review outputs are never injected into their prompts**

The worker tasks (`needs: { plan: "${prefix}-plan" }`, line 36), the review task (line 56) and the final task (line 82) declare `needs` but no `deps`, and have static string prompts (e.g. "Refer to the plan for your specific instructions."). In Task.js, dependency edges are derived only from `deps` (`deriveDepNodeIds` returns undefined when `deps` is absent, so `dependsOn` stays empty), and at runtime the agent prompt sent to the model is just `desc.prompt` (packages/engine/src/engine.js:3358/4100). `needs` is consumed only by `buildCacheContext` (engine.js:1666) for cache keys; it is never injected into the agent prompt. The mechanism that actually puts upstream output into a prompt is `deps` + a children function (see task-deps.test.jsx). Consequently the boss's plan is never delivered to the workers, and the workers'/plan outputs are never delivered to the review/final agents: the workers operate blind, defeating the component's purpose. Ordering is still correct because the outer `Sequence` serializes plan -> loop -> final, so this is a context-injection defect, not a deadlock.

**Fix:** Give the worker/review/final tasks real `deps` (e.g. `deps={{ plan: props.planOutput }}`) and a children function that embeds the resolved plan/review JSON into the prompt, or otherwise interpolate the upstream output into the prompt text. `needs` alone does not pass data to agent prompts.

*Verifier:* Verified against actual code. Task.js deriveDepNodeIds (lines 86-88) returns undefined when deps is absent, so needs-without-deps creates no dependsOn edge in the React component path Supervisor uses. With a static string children, Task.js sets childValue=children (line 244, function branch skipped) and prompt=renderPromptToText(string); the needs map is not read at render time for prompts. In engine.js the agent prompt is effectivePrompt=desc.prompt (line 3358) plus only schema/tool boilerplate; grepping all packages/*/src for .needs shows the engine consumes desc.needs solely in buildCacheContext (engine.js:1666-1684), which feeds only desc.cachePolicy.by(ctx) for cache keys (3000-3002), never the prompt. TaskProps.ts:32 confirms the actual injection path is deps + a children function; Supervisor uses neither. So the boss plan, worker results, and review output never enter the worker/review/final prompts (which are hardcoded, uncustomizable static strings), and ordering survives only via the outer Sequence. The builder.js needs->dependsOn/buildNeedsContext wiring is a separate programmatic API, not this component's path, so it does not rescue it. Confidence/severity held at medium because the same needs+static-string convention is pervasive across sibling composite components (Optimizer, ReviewLoop, Debate, ScanFixVerify), suggesting the maintainers may treat agents as sharing a working directory out-of-band; but with the plan stored only as DB output (never written to disk) and useWorktrees isolating workers, the delegation is genuinely hollow. This is a real context-injection defect, not a crash/deadlock.

### 76. [MEDIUM · correctness] `packages/components/src/renderMdx.js:23`

**renderMdx HTML-escapes &, <, > so emitted "markdown" is corrupted**

renderMdx claims to "Render an MDX component to plain markdown text" and is consumed to build agent prompts (e.g. Task.js). It produces output with `renderToStaticMarkup(element)`. react-dom/server escapes every text node for XSS safety, so any literal `&`, `<`, `>` in the source content is converted to `&amp;`, `&lt;`, `&gt;` in the returned string. The markdownComponents only add wrapper punctuation (`# `, backticks, etc.) and never unescape, so the text that flows through them is escaped too. Real docs/code routinely contain these characters: a fenced code block `if (a < b && c > d)` becomes ```` ```js
if (a &lt; b &amp;&amp; c &gt; d)
``` ````, and TypeScript generics `Array<T>` become `Array&lt;T&gt;`. The existing test only exercises `const x = 1;` and `Hello World`, which contain no special characters, so it never surfaces the corruption. The agent receiving the rendered prompt sees HTML entities instead of the real source, degrading correctness of any workflow whose .mdx contains code or angle brackets.

**Fix:** Don't round-trip markdown through an HTML serializer. Either decode HTML entities after renderToStaticMarkup (e.g. replace &amp;/&lt;/&gt;/&#x27;/&quot;), or render to a plain-string sink that doesn't escape (custom tree-walk over the React element), so literal &, <, > survive into the markdown output.

*Verifier:* Confirmed empirically: renderMdx at packages/components/src/renderMdx.js:23 calls renderToStaticMarkup(element), which escapes text nodes. A reproduction using markdownComponents produced `if (a &lt; b &amp;&amp; c &gt; d)` for a code block and `Array&lt;T&gt; &amp; Map&lt;K,V&gt;` for a paragraph. markdownComponents.js only adds wrapper punctuation and never decodes entities, and there is no decode step in renderMdx (only \n collapse + trim). The function is documented as producing 'plain markdown text' so the escaped entities violate its stated contract for any .mdx containing code or angle brackets. The existing test (render-mdx.test.jsx) only uses `const x = 1;` and `Hello World`, neither containing special chars, so it never surfaces the corruption. The same renderToStaticMarkup+markdownComponents pattern is used to build real agent prompts (renderPromptToText in components/src/components/Task.js) and human prompts (renderHumanPromptToText in engine deferred-state-bridge.js), so escaped output does reach prompts consumed as raw text. Minor inaccuracy in the claim: Task.js uses its own copy rather than calling renderMdx, but the defect in renderMdx.js itself is real. Severity medium rather than high because LLM consumers typically still interpret entities, but code-heavy prompts are genuinely degraded.

### 77. [MEDIUM · data-loss] `packages/control-plane/src/index.js:1060`

**putSecretRef persists the secret ref but then throws (and skips the audit) for secret names containing characters outside ID_RE**

`putSecretRef` validates the secret name with the permissive `nonEmptyString` (line 1022: `const name = nonEmptyString("name", input.name);`), which accepts any non-empty trimmed string including dots, spaces and slashes (e.g. `db.password`, `prod/db/password`, `stripe.secret key`). The INSERT...ON CONFLICT at lines 1033-1053 commits immediately (no enclosing transaction). Only AFTER the write does it call `recordAuditEvent({ ..., targetId: name, ... })` (line 1060). Inside `recordAuditEvent` (line 1118) the target id is re-validated with the much stricter `requiredId("targetId", input.targetId)`, which enforces `ID_RE = /^[A-Za-z0-9:_-]{1,128}$/` (no dots/spaces/slashes). So for a perfectly legal secret name like `stripe.api_key`, the secret ref is written/rotated and persisted, yet `putSecretRef` throws `INVALID_INPUT: targetId must match ...`. The caller sees a failure (and may retry or assume nothing was stored) even though the secret ref was created/overwritten, and NO audit event is recorded for a security-sensitive secret mutation. This is a partial-write + missing-audit-trail defect, not mere style.

**Fix:** Either validate `name` against ID_RE up front in putSecretRef (fail before the INSERT), or stop forcing the audit `targetId` through `requiredId`. Simplest: in recordAuditEvent treat targetId as an opaque label via `nonEmptyString` rather than `requiredId`, OR pass a stable id (e.g. the secret's project_key+name hash) as targetId and keep the human name in metadata. Also consider wrapping the INSERT and recordAuditEvent in a single sqlite.transaction so the audit and write commit atomically.

*Verifier:* Confirmed concrete partial-write + missing-audit defect. putSecretRef validates the secret name only with nonEmptyString at line 1022 (trim + non-empty), which accepts dots/spaces/slashes. The INSERT...ON CONFLICT at 1033-1053 commits under autocommit. THEN recordAuditEvent is called at 1054 with targetId: name, and recordAuditEvent re-validates targetId at line 1118 with requiredId → ID_RE = /^[A-Za-z0-9:_-]{1,128}$/ which excludes '.'. Verified: ID_RE.test('stripe.api_key') === false while it is a perfectly legal secret name. So a dotted secret name persists/rotates the secret row, then putSecretRef throws INVALID_INPUT before any audit row is written. Caller sees a failure though the secret ref is stored, and NO audit event records the security-sensitive secret mutation. Tests only use hyphenated names (e.g. 'billing-token') so this gap is untested. Real defect.

### 78. [MEDIUM · data-loss] `packages/db/src/adapter.js:1941`  _(corroborated ×2)_

**Postgres signal/event seq allocation is not cross-process safe (lost rows), unlike SQLite**

insertSignalWithNextSeq (and the identical insertEventWithNextSeq at ~2208) take two code paths. The bun:sqlite path runs `client.run("BEGIN IMMEDIATE")`, reads `SELECT COALESCE(MAX(seq),-1)+1`, INSERTs, COMMITs — a SQLite write lock that is correct across processes. The non-bun (Postgres/PGlite) fallback instead does `lastSeq = getLastSignalSeq(); seq = lastSeq+1; insertIgnore(...)` serialized only by the in-process `acquireTransactionTurn()`. The WeakMap-based turn is per-client/per-process, so it gives no cross-process mutual exclusion. Two processes writing to the SAME run on a shared Postgres DB (a realistic case for signals: external `smithers signal` invocations and/or a resume race) can both read the same lastSeq and compute the same seq. `insertIgnore` does `ON CONFLICT DO NOTHING`, so the loser's row is silently dropped — yet the function still `return seq`, reporting success for a signal/event that was never persisted (the seq now belongs to a different row). The result is silent loss of a durable signal/event plus a wrong returned seq, exactly the failure the comment claims to prevent, but only the SQLite branch actually prevents it. The whole shape (a Postgres-backed shared store) is the configuration where this matters most.

**Fix:** On the Postgres path, allocate the seq atomically in one statement, e.g. `INSERT INTO _smithers_signals (run_id, seq, ...) SELECT ?, COALESCE(MAX(seq),-1)+1, ... FROM _smithers_signals WHERE run_id=? RETURNING seq`, and on a unique-violation retry (let withSqliteWriteRetryEffect catch the conflict error) rather than swallowing it with ON CONFLICT DO NOTHING; return the actually-inserted seq from RETURNING.

*Verifier:* Confirmed, same root cause as finding 3 and additionally the event path. insertEventWithNextSeq fallback (L2189-2215) does getLastEventSeq → seq=lastSeq+1 → insertIgnore('_smithers_events',{...,seq}) under the in-process acquireTransactionTurn only; bun:sqlite branch (L2216-2244) uses BEGIN IMMEDIATE. The WeakMap turn does not span processes, insertIgnore is ON CONFLICT DO NOTHING on (run_id, seq), and the function returns seq regardless of whether the row persisted. On a shared Postgres backend two processes writing the same run can lose a signal/event and report a wrong seq. Events are usually written by a single run-owner process so the event variant is narrower than signals, but the asymmetry vs the SQLite branch is real.

### 79. [MEDIUM · correctness] `packages/db/src/adapter.js:2671`

**listMemoryFacts uses untyped `? IS NULL` which can fail to type-infer on Postgres**

listMemoryFacts emits `WHERE (? IS NULL OR namespace = ?)`. On the SQLite path this works. On Postgres, translatePlaceholders rewrites it to `WHERE ($1 IS NULL OR namespace = $2)`. The first placeholder appears only as `$1 IS NULL` with no column/operator context, so Postgres' parser may reject it with `could not determine data type of parameter $1` (the classic untyped-parameter error), making `smithers memory list` fail on a Postgres/PGlite-backed store. Other nullable comparisons in this file avoid the problem by giving the parameter type context (`heartbeat_at_ms IS NOT DISTINCT FROM ?`, `? = 0 OR ...`).

**Fix:** Give the parameter a type or remove the untyped IS NULL test, e.g. cast (`CAST(? AS TEXT) IS NULL OR namespace = ?`) or branch the SQL: when namespace is null, omit the predicate entirely; otherwise emit `namespace = ?` with a single bound value.

*Verifier:* Confirmed and reproduced. listMemoryFacts (L2667-2672) emits `WHERE (? IS NULL OR namespace = ?)`. Postgres params go through createPostgresConnection (sql-message-storage.js L641-653) as `pgConn.query({text, values})` with translatePlaceholders turning it into `($1 IS NULL OR namespace = $2)`. $1 appears only as `$1 IS NULL` with no type context. I ran this exact predicate against PGlite and both the null and non-null cases failed with `could not determine data type of parameter $1`. So `smithers memory list` (and the gateway listMemoryFacts RPC) errors on any Postgres/PGlite-backed store. The other nullable comparisons in the file avoid this by giving type context (`heartbeat_at_ms IS NOT DISTINCT FROM ?` at L1058, `? = 0 OR ...` at L1059/1080). No test exercises this path on the PG dialect. Read-only command, hence medium severity.

### 80. [MEDIUM · data-loss] `packages/db/src/dialect.js:169`

**translateDdl rewrites user column names equal to INTEGER/REAL/BLOB inside quoted identifiers**

`translateDdl` applies unanchored, case-insensitive global regexes to the whole DDL string:

  .replace(/\bBLOB\b/gi, "BYTEA")
  .replace(/\bREAL\b/gi, "DOUBLE PRECISION")
  .replace(/\bINTEGER\b/gi, "BIGINT")

These `\b...\b` boundaries match the keyword even when it appears as a quoted IDENTIFIER (column name), because the regex ignores the surrounding double-quotes. The docstring asserts "Only the controlled, internal Smithers DDL passes through here (no user-supplied text)", but that contract is violated: `packages/smithers/src/migrateSmithersStore.js` reads the raw `CREATE TABLE`/`CREATE INDEX` `sql` for every user output/input table out of `sqlite_master` (lines 132-135) and feeds it straight through `translatedCreateTable`/`translatedCreateIndex` -> `translateDdl(POSTGRES, ddl)` (lines 222-234, 318/333/435). A user output schema with a field that snake-cases to a type keyword (e.g. z.object({ integer: z.number() }), or fields named `real`/`blob`) produces a stored DDL column `"integer" TEXT`. I reproduced the result: `CREATE TABLE "out_x" (... "integer" TEXT, "real" TEXT, "blob" TEXT)` becomes `... "BIGINT" TEXT, "DOUBLE PRECISION" TEXT, "BYTEA" TEXT`. The migrated Postgres table then has columns named BIGINT/DOUBLE PRECISION/BYTEA instead of the originals, so the subsequent row INSERTs that reference the real column names fail (or land in the wrong column), corrupting/aborting the `smithers migrate` of that user's data. The live Postgres CREATE path is safe because it uses zodToCreateTableSQL+columnType per-type, so only the migrate command is affected.

**Fix:** Do not run keyword-level regex substitution over text that can contain user identifiers. For migrateSmithersStore, regenerate DDL from the parsed column list (using columnType per column type token) rather than regex-rewriting the raw sqlite_master SQL; or make translateDdl skip content inside double-quoted identifiers (reuse the quote-tracking state machine already in translatePlaceholders) so `"integer"` is left untouched while a bare `INTEGER` type token is translated.

*Verifier:* Confirmed real. translateDdl (dialect.js:164-170) applies unanchored /\bINTEGER\b/gi, /\bREAL\b/gi, /\bBLOB\b/gi globally. JS word boundaries treat the surrounding double-quotes as \W, so the keyword matches INSIDE a quoted identifier; I reproduced `"integer" REAL` -> `"BIGINT" DOUBLE PRECISION`, `"real"`->`"DOUBLE PRECISION"`, `"blob"`->`"BYTEA"`. The contract 'no user-supplied text' IS violated: migrateSmithersStore.js sourceTables/sourceIndexes (lines 130-148) read raw CREATE sql for EVERY user output/input table out of sqlite_master and feed it through translatedCreateTable/translatedCreateIndex -> translateDdl(POSTGRES,...) (lines 222-234, 318, 333, 435). assertNoReservedColumns.js only reserves run_id/node_id/iteration, so user fields named integer/real/blob are allowed and zodToCreateTableSQL.js:76 emits them quoted. The PG table is therefore created with columns named BIGINT/DOUBLE PRECISION/BYTEA, while copyTable reads the real names via PRAGMA table_info (sourceColumns, line 348) and emits INSERT INTO ... ("integer",...) -> column-does-not-exist -> the migrate of that user's data aborts via withAgentFallback. The claim's 'lands in the wrong column' is slightly off (it hard-fails rather than silently mis-routing), but the underlying defect, reachability, and contract violation are genuine. The live (non-migrate) CREATE path is safe because it uses columnType per-type, as the claim notes. Edge case (requires a field literally named integer/real/blob + migrate to pg/pglite), hence medium not high.

### 81. [MEDIUM · correctness] `packages/db/src/runState/parseEventMeta.js:9`

**parseEventMeta reads non-existent meta keys, so waiting-event correlationKey is always empty**

parseEventMeta extracts the correlation key with:

```js
const key =
    parsed?.event?.correlationKey ??
    parsed?.correlationKey ??
    parsed?.event?.eventName ??
    null;
```

It looks for `event.correlationKey`, top-level `correlationKey`, or `event.eventName`. But the engine never writes any of those keys. The only writer of waiting-event attempt metaJson is `buildWaitForEventAttemptMeta` in packages/engine/src/effect/deferred-state-bridge.js (used at lines 759/796/843/931), which serializes `{ kind: "wait-for-event", waitForEvent: { signalName, correlationId, ... } }`. A repo-wide grep confirms the string `correlationKey` is never produced anywhere in engine/driver/smithers source. As a result, for every real run `parseEventMeta` returns null, and `loadPendingEvent` (computeRunStateFromRow.js:103) falls back to `correlationKey: ""`. The RunStateView for a `waiting-event` run therefore always reports `blocked.correlationKey === ""`, so any CLI/gateway/UI consumer can never see which event/signal the run is actually blocked on. The unit test (packages/db/tests/runState-computeRunState.test.js:137) only passes because it fabricates `metaJson: { event: { correlationKey: "order:42" } }`, a shape the engine never persists, so the test masks the defect rather than catching it. Note the timer counterpart parseTimerMeta is correct because it reads `parsed?.timer?.firesAtMs`, which matches buildTimerAttemptMeta's `{ timer: { firesAtMs } }`.

**Fix:** Read the keys the engine actually writes, e.g.:
```js
const we = parsed?.waitForEvent;
const key = we?.correlationId ?? we?.signalName ?? parsed?.event?.correlationKey ?? null;
```
and update the test to use the real `{ kind: 'wait-for-event', waitForEvent: { signalName, correlationId } }` shape so it exercises production data.

*Verifier:* Confirmed. The only persisted waiting-event attempt metaJson shape is {kind:'wait-for-event', waitForEvent:{signalName, correlationId,...}} from buildWaitForEventAttemptMeta (deferred-state-bridge.js:394-409, used at 759/796/843) and buildResolvedWaitForEventMetaJson (durable-deferred-bridge.js:112). parseEventMeta (parseEventMeta.js:10-13) only reads event.correlationKey / top-level correlationKey / event.eventName, none of which exist in that shape, so it always returns null for real runs and loadPendingEvent (computeRunStateFromRow.js:103) falls back to correlationKey:''. Repo grep shows correlationKey is never persisted as an attempt-meta key. The unit test (runState-computeRunState.test.js:136-138) fabricates {event:{correlationKey}} which the engine never writes, masking the bug. Impact is display/diagnostic only (run resumption uses __eventName matching in engine.js, not this field), so medium severity is appropriate.

### 82. [MEDIUM · correctness] `packages/db/src/snapshot.js:130`

**loadInput on Postgres returns boolean columns as 0/1 numbers, not booleans (dialect inconsistency)**

`loadInputEffect`'s Postgres branch maps the row with `pgRowToDrizzle(result.rows[0], jsonKeys)` and returns it directly, never applying `coerceBooleanColumns`:

```js
.then((result) => (result.rows[0] ? pgRowToDrizzle(result.rows[0], jsonKeys) : undefined)),
```

Boolean Zod fields are stored as INTEGER columns in BOTH dialects (zodToCreateTableSQL.js line 21-22: `if (baseTypeName === "boolean" ...) return "INTEGER"`; zodToTable.js uses `integer(col,{mode:'boolean'})`). On the bun:sqlite path, `db.select()` uses Drizzle's mode:'boolean' reader and returns real JS `true`/`false`. On the Postgres path, node-postgres returns the INTEGER column as the JS number `0`/`1`, and `pgRowToDrizzle` only JSON-decodes json/payload columns (it has no boolean handling). So the same input field comes back as `false`/`true` under SQLite but `0`/`1` under Postgres.

This breaks the file's stated dialect-agnostic contract (see the `pgRowToDrizzle` doc comment: 'so input/output consumers stay dialect-agnostic'). The sibling readers `loadOutputsEffect` (line 191-192) and `loadRunOutputRowsEffect` (line 245) both fix exactly this by calling `coerceBooleanColumns(rawRows, getBooleanColumnKeys(table))`; `loadInputEffect` is the only reader that omits it. A workflow that reads a boolean field from `ctx.input` on a Postgres-backed store gets a number: strict comparisons (`=== true` / `=== false`), JSON serialization, and any boolean-typed consumer misbehave, and behavior silently differs from SQLite.

**Fix:** In the Postgres branch of loadInputEffect, coerce boolean columns the same way the output readers do, e.g. compute `const boolKeys = getBooleanColumnKeys(inputTable);` and return `result.rows[0] ? coerceBooleanColumns([pgRowToDrizzle(result.rows[0], jsonKeys)], boolKeys)[0] : undefined`.

*Verifier:* Confirmed in real code. snapshot.js:130 loadInputEffect Postgres branch returns pgRowToDrizzle(result.rows[0], jsonKeys) with no coerceBooleanColumns call. pgRowToDrizzle (97-116) only JSON-decodes payload/jsonKeys columns, no boolean handling. Boolean Zod fields are stored as integer columns in both dialects (zodToCreateTableSQL.js:21-22 returns INTEGER for boolean; dialect.js:138-139 maps INTEGER->BIGINT for Postgres), while the bun:sqlite table uses integer(col,{mode:'boolean'}) (zodToTable.js:55-56) so Drizzle returns real JS booleans. The two sibling readers loadOutputsEffect (191-192) and loadRunOutputRowsEffect (245) BOTH call coerceBooleanColumns(rawRows, getBooleanColumnKeys(table)); loadInputEffect is the only one that omits it. loadInput feeds ctx.input in engine.js (1462,1657,5292,...), so a Postgres-backed store returns boolean input fields as 0/1 instead of false/true, diverging from SQLite. Genuine dialect-consistency defect; medium severity since it only affects Postgres backends with boolean input fields.

### 83. [MEDIUM · logic] `packages/devtools/src/DevToolsRunStore.js:261`

**NodeWaitingTimer unconditionally overrides a stronger waiting-approval run status**

The `NodeWaitingTimer` handler sets the run-level status without respecting block priority:

```js
case "NodeWaitingTimer": {
    const task = this.ensureTask(run, event.nodeId, event.iteration);
    if (isTerminalTask(task)) break;
    task.status = "waiting-timer";
    if (!isTerminalRun(run)) {
        run.status = "waiting-timer";   // overrides waiting-approval
    }
    break;
}
```

The design explicitly treats approval as the strongest block (see `refreshRunWaitingStatus`: "Approval is the strongest block; nothing can override it", and the test 'waiting-approval downgrades to waiting-timer when only a timer node remains blocked'). But this direct setter blindly writes `run.status = "waiting-timer"` even when `run.status` is already `waiting-approval` with a still-pending approval task.

Concrete failure: in a workflow with parallel branches, branch A hits an approval gate (NodeWaitingApproval → run.status = waiting-approval) and then branch B hits a timer (NodeWaitingTimer). The run status is incorrectly downgraded to `waiting-timer`, hiding the fact that a human approval is still required. The existing test only covers the reverse order (timer first, then approval), so the bug is uncovered. Symmetrically `NodeWaitingApproval` overriding `waiting-timer` is correct (approval wins), so only the timer handler is wrong.

**Fix:** Make the timer setter priority-aware: only set the run to waiting-timer if it is not already waiting-approval, e.g. `if (!isTerminalRun(run) && run.status !== "waiting-approval") run.status = "waiting-timer";`, or route both waiting handlers through a priority-respecting helper like `refreshRunWaitingStatus` after setting the task status.

*Verifier:* NodeWaitingTimer (lines 256-265) sets run.status='waiting-timer' whenever !isTerminalRun(run), with no guard against an active 'waiting-approval'. refreshRunWaitingStatus (44-55) documents 'Approval is the strongest block; nothing can override it', and NodeWaitingApproval correctly overrides waiting-timer (approval wins). But the reverse path is broken: if branch A emits NodeWaitingApproval (run.status='waiting-approval') and then branch B emits NodeWaitingTimer, the handler downgrades run.status to 'waiting-timer' while task A is still waiting-approval. The state persists until an unrelated event re-triggers refreshRunWaitingStatus (which only acts when run.status is already a waiting status). The existing downgrade test (line 451) only covers timer-first-then-approval, so this approval-first ordering is uncovered. Real logic/observability bug in run-status reporting. Severity medium since this is a devtools display store, not data loss.

### 84. [MEDIUM · resource-leak] `packages/driver/src/child-process.js:64`  _(corroborated ×2)_

**kill() leaves the other timer (total/idle) running after timeout/abort**

The `kill(reason, code)` helper (lines 64-90) resumes the Effect with a failure but never clears `totalTimer` or `idleTimer`. Timers are only cleared in `finalize` (lines 126-129), the `child.on("error")` handler (lines 184-187), and the Effect.async interruption finalizer (lines 215-218). But that finalizer only runs on Effect interruption, NOT when `kill` itself resumes a failure. So when a process is killed via abort signal (lines 145/148), `PROCESS_TIMEOUT` (line 114-116), or `PROCESS_IDLE_TIMEOUT` (line 105-110), the *other* still-pending timer survives. Concrete failures: (1) after a total-timeout kill, the surviving idle timer (and vice-versa) later fires and calls `kill` again, emitting a misleading `"child process interrupted"` warning with the wrong errorCode even though the effect already settled (`settled` is true so no second resume, but the log is spurious); (2) on an abort that kills the child, the surviving `totalTimer` keeps the Node event loop alive until it fires (up to the full `timeoutMs`, potentially many minutes), delaying process exit. Quote: the `kill` body kills the child and resumes but has no `clearTimeout(totalTimer)`/`clearTimeout(idleTimer)`.

**Fix:** At the top of `kill`, before/after killing, clear both timers: `if (totalTimer) clearTimeout(totalTimer); if (idleTimer) clearTimeout(idleTimer);` (mirroring what `finalize` does).

*Verifier:* Confirmed in code. kill() (lines 64-90) sets settled=true and resume(Effect.fail(...)) but never calls clearTimeout(totalTimer)/clearTimeout(idleTimer). finalize() (line 122-129) clears timers ONLY after the `if (settled) return;` guard at line 123-124, so the post-kill `close` event hits finalize, returns early, and never clears. The Effect.async cleanup finalizer (lines 214-235) only runs on fiber interruption, not when kill() resumes a failure via the external AbortSignal/timeout. So on abort (line 148), PROCESS_TIMEOUT (114), or PROCESS_IDLE_TIMEOUT (105) the OTHER pending timer survives armed (not unref'd), keeping the event loop alive up to timeoutMs and later re-firing kill() which logs a spurious 'child process interrupted' warning with the wrong errorCode (second resume blocked by settled). Genuine timer/event-loop leak; medium severity (delayed exit in one-shot CLI, spurious logs in daemons).

### 85. [MEDIUM · crash] `packages/driver/src/SmithersCtx.js:98`

**SmithersCtx constructor crashes when a workflow output table is named "name" or "length"**

The constructor builds the `outputs` accessor as a function and then copies every output table onto it as a property:

```js
const outputsFn = (table) => opts.outputs[table] ?? [];
for (const [name, rows] of Object.entries(opts.outputs)) {
    outputsFn[name] = rows;
}
```

`outputsFn` is a function, and JavaScript functions have non-writable own properties `name` and `length`. Because this is an ES module (always strict mode), assigning to a non-writable property throws `TypeError: Cannot assign to read only property 'name'/'length'` (verified empirically). So if a workflow declares an output schema/table keyed `name` or `length` (both plausible names), constructing `SmithersCtx` throws and the entire render fails for that workflow with a confusing, unrelated error message — rather than the data flowing through. The function-call form `ctx.outputs('name')` would work; only the property-attachment loop crashes, and it crashes for the whole context, not just that table.

**Fix:** Don't attach table rows as own properties of a function. Either build the accessor with a Proxy whose `get` trap returns `opts.outputs[prop] ?? []` for any string key, or attach properties via `Object.defineProperty(outputsFn, name, { value: rows, enumerable: true, configurable: true, writable: true })` while skipping/guarding the reserved function keys (`name`, `length`), or expose `outputs` as a plain object plus a separate lookup function instead of overloading a function object.

*Verifier:* Lines 97-100: outputsFn is an arrow function; JS functions have non-writable own properties 'name' and 'length'. In ESM strict mode (this file is an ES module; Bun ESM is also strict) `outputsFn[name] = rows` throws TypeError when name==='name' or 'length'. Reproduced empirically with Node: 'Cannot assign to read only property name of function'. OutputSnapshot/OutputAccessor types show output keys are arbitrary user-chosen table names with NO reserved-name guard, and the OutputAccessor type even promises property access (mapped type over keyof Schema), so the loop is the intended path. A workflow with an output table named 'name' (very plausible) or 'length' crashes the entire SmithersCtx constructor and render with a confusing unrelated error. Genuine reachable crash; medium severity given it requires a specific (but common) table name.

### 86. [MEDIUM · error-handling] `packages/driver/src/WorkflowDriver.js:486`

**Task failures whose message/name contains "abort" silently cancel the whole run**

In `startInflightTask`, a thrown task error is classified as a cancellation when `context.signal?.aborted || isAbortError(error)` is true (line 486). `isAbortError` (lines 198-204) returns true for ANY error whose `name` or `message` matches `/abort/i`, independent of whether the run's AbortSignal actually fired. So a genuine task failure with a message like "socket hang up: request aborted", "The operation was aborted", or a fetch/agent `AbortError` produced by an internal per-request timeout (signal NOT aborted) is returned as `kind: "cancelled"`. In `nextCompletionDecision`, `if (settled.kind === "cancelled") return this.cancelRun();` (line 544) then tears down the ENTIRE run via `session.cancelRequested()` and reports status `cancelled` instead of `failed`/retry. A single failing task that mentions "abort" in its error therefore silently cancels every other in-flight task and the whole workflow, masking the real failure.

**Fix:** Only treat an error as cancellation when the signal is actually aborted: classify as cancelled iff `context.signal?.aborted`. Drop the message/name heuristic, or restrict it to errors carrying a proper `name === "AbortError"` AND `context.signal?.aborted`.

*Verifier:* Confirmed. isAbortError (lines 198-204) returns true for ANY error whose name or message matches /abort/i. In startInflightTask line 486 the classifier is `if (context.signal?.aborted || isAbortError(error))`. Crucially, withAbort (withAbort.js) only throws an AbortError when the run's own signal fired (abortPromise rejects only on signal abort), so the only way isAbortError fires WITHOUT signal.aborted is when executeTask itself throws an abort-named error (e.g. an AbortError from an internal per-request timeout / fetch AbortController, or a failure message like 'operation was aborted'). That settled task is returned as kind:'cancelled', and nextCompletionDecision line 544 `if (settled.kind === 'cancelled') return this.cancelRun()` tears down the entire run via session.cancelRequested() and reports status 'cancelled' rather than failed/retry. A single failing task whose error mentions 'abort' masks the real failure and cancels the whole workflow. Real defect; medium because it requires the specific error text but the blast radius (whole-run cancel, silent) is large.

### 87. [MEDIUM · resource-leak] `packages/electric-proxy/src/serveSmithersElectricProxy.ts:67`

**Client disconnect never cancels the upstream Electric stream (live-shape / slot leak)**

The HTTP handler does `void proxy.fetch(...).then(writeFetchResponse)` and `writeFetchResponse` reads the response body in a loop:
```
const reader = response.body.getReader();
for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) res.write(Buffer.from(value)); }
```
Nothing listens for the client aborting the connection (`res`/`req` `"close"`/`"aborted"`). The proxy body returned by `wrapBody()` is a `ReadableStream` whose `cancel()` is the only thing that invokes `reader.cancel()` and `hooks.release()` (releasing the active-shape slot). Because the server-side reader is never cancelled on client disconnect, that `cancel()` is never called: the upstream Electric request keeps being drained and the active-shape slot stays held. Electric live shapes are served with `accept: text/event-stream` (see createSmithersElectricProxy.ts ~line 420) and can be long-lived, so every browser that navigates away / drops its connection leaks an upstream SSE connection plus a proxy slot until the active-shape TTL eventually reclaims it. Under churn this exhausts upstream connections and slots.

**Fix:** In the createServer callback, attach `res.on('close', () => { /* if not finished */ reader.cancel().catch(()=>{}) })`, or pass an AbortSignal wired to the response close into `writeFetchResponse` and call `reader.cancel()` (or `response.body.cancel()`) when the client disconnects so the wrapped stream's cancel hook releases the slot and tears down the upstream stream.

*Verifier:* Confirmed. serveSmithersElectricProxy.ts lines 67-77 do `void proxy.fetch(...).then(writeFetchResponse)` and register no 'close'/'aborted' listener on req/res. writeFetchResponse (lines 42-49) calls response.body.getReader() and loops on reader.read()/res.write(), only breaking on `done`. In createSmithersElectricProxy.ts, wrapBody (lines 497-533) is a ReadableStream whose cancel() (lines 529-532) is the only place that calls reader.cancel() on the upstream Electric reader AND done()->hooks.release(). The server-side consumer never cancels its reader on client disconnect, so for a long-lived live shape (which never hits chunk.done) the upstream SSE connection keeps being drained and the active slot stays held. Worse than the claim states: once a slot is draining=true, sweepExpired (line 363, `!slot.draining` guard) never reclaims it, so the TTL does NOT eventually free it — the slot/upstream leak until upstream ends, which for a live shape may be never. Genuine resource leak; medium is appropriate.

### 88. [MEDIUM · logic] `packages/engine/src/effect/deferred-state-bridge.js:1210`

**approvalOnDeny:"skip" is treated as "continue" and executes the denied node instead of skipping it**

`approvalOnDeny` is a 3-value contract (`"fail" | "continue" | "skip"`, see builder.js:21/160 and graph extract.js:619-642). In the denied-approval branch the bridge only distinguishes fail vs not-fail:

```js
if (desc.approvalMode !== "gate" && desc.approvalOnDeny !== "fail") {
  // try existing output, else:
  await Effect.runPromise(adapter.insertNode({ ... state: "pending" ... }));
  await emitStateEvent?.("pending");
  return { handled: true, state: "pending" };
}
```
The only path that produces a `skipped` node in this branch is via `desc.continueOnFail` inside the `onDeny==="fail"` sub-branch (line 1245). For `onDeny:"skip"` the function returns `"pending"`, and the engine then runs `shouldExecuteDeniedApprovalTask` (engine.js:5077-5095) which is also gated only on `approvalOnDeny !== "fail"`, so it calls `resolveSessionApproval(approval, true)` — i.e. it EXECUTES the denied task as if approved. Net effect: `onDeny:"skip"` behaves identically to `onDeny:"continue"`; the node (and its side effects) runs instead of being skipped, and downstream `needs` see a real output instead of a skip. Compare with WaitForEvent timeout handling (resolveWaitForEventTimeoutBridge, lines 829-860) which correctly distinguishes continue (finish) from skip (state "skipped"). The approval path lost that distinction.

**Fix:** In the denied non-fail branch, branch on the concrete value: for `desc.approvalOnDeny === "skip"`, write node state `"skipped"` (and emit "skipped") and return `{handled:true,state:"skipped"}` rather than `"pending"`. Also tighten engine.js `shouldExecuteDeniedApprovalTask` to only execute when `approvalOnDeny === "continue"`.

*Verifier:* Real logic gap. approvalOnDeny supports fail|continue|skip (extract.js:619-623, builder/types). The bridge denied branch (line 1210) only distinguishes fail vs not-fail, returning 'pending' for both continue and skip. engine.js:5092-5098 on 'pending' calls shouldExecuteDeniedApprovalTask (5077-5079: denied && approvalMode!=gate && approvalOnDeny!=fail) which is true for skip, then runs resolveSessionApproval(approval, true) — executing the denied non-gate approval node as if approved. No path produces a 'skipped' node for onDeny:'skip' (only continueOnFail inside the onDeny==='fail' sub-branch yields skipped at 1245). The WaitForEvent timeout handler (829-861) correctly distinguishes continue (finish) from skip (state 'skipped'), confirming skip should produce a skipped node. So onDeny:'skip' silently behaves like continue and runs the node plus its side effects instead of skipping it. Requires the specific non-gate (decision/select/rank) approval config with onDeny:skip getting denied, hence medium severity.

### 89. [MEDIUM · error-handling] `packages/engine/src/effect/static-task-bridge.js:32`

**Over-broad abort detection misclassifies real failures as cancellations and discards the original error**

`isAbortError` ends with `if (err instanceof Error) { return /aborted|abort/i.test(err.message); }` (lines 29-34). Any error whose message merely contains the substring "abort"/"aborted" (e.g. a DB or downstream error like "Connection aborted", "operation was aborted") is treated as a deliberate cancellation. In the catch block this drives `const aborted = taskSignal.aborted || isAbortError(err);` (line 204). When `aborted` is true via the regex but `taskSignal.aborted` is false, `taskSignal.reason` is undefined, so `effectiveError = makeAbortError()` (lines 205-209) — the ORIGINAL error `err` is thrown away and replaced with a generic abort error. The task is then recorded with state `"cancelled"`, a `NodeCancelled` event is emitted, the function `return`s early (line 249), and crucially the failure path (NodeFailed + retry accounting at lines 281-301) is skipped. Net effect: a genuine, possibly retryable failure is silently converted into a non-retryable cancellation and the real error message/stack is lost from `errorJson`.

**Fix:** Do not infer abort from arbitrary message substrings. Restrict abort detection to `taskSignal.aborted` plus a real `AbortError` (name check / DOMException), and drop the `/aborted|abort/i.test(err.message)` fallback (or require an exact `err.name === 'AbortError'`). Preserve `err` as `effectiveError` when the signal was not actually aborted.

*Verifier:* Confirmed in the real code. isAbortError (lines 21-35) falls back to `/aborted|abort/i.test(err.message)` for any Error, so any error whose message contains the substring 'abort' is treated as a deliberate cancellation. Line 204 sets `aborted = taskSignal.aborted || isAbortError(err)`. When aborted is true via the regex but taskSignal.reason is undefined, lines 205-209 set effectiveError = makeAbortError() (a generic TaskAborted with message 'Task aborted', name 'AbortError', per bridge-utils.js), discarding the original err. The aborted branch (210-250) records state 'cancelled', emits NodeCancelled, and returns at line 249, bypassing the NodeFailed/retry accounting at 281-301. The try body performs real DB transactions (withTransaction/upsertOutputRow), getJjPointer, and event persistence — genuine failure sources. With the pluggable Postgres backend, the extremely common error 'current transaction is aborted, commands ignored until end of transaction block' contains 'aborted' and would be misclassified as a cancellation: the real error message/stack is lost from errorJson and a retryable failure is silently turned into a non-retryable cancellation. The correct, narrow check (err.name === 'AbortError') already exists at lines 24-30; the message-substring fallback is the over-broad defect. Severity medium: real wrong behavior but contingent on error messages containing 'abort'.

### 90. [MEDIUM · correctness] `packages/engine/src/engine.js:1357`

**Postgres continue-as-new cancellation re-check is dead (camelCase alias folded to lowercase)**

In `continueRunAsNewPostgres`, the in-transaction cancellation re-check queries:

```js
const cancelState = yield* Effect.tryPromise({
  try: () => storage.queryOne("SELECT cancel_requested_at_ms AS cancelRequestedAtMs FROM _smithers_runs WHERE run_id = ? LIMIT 1", [runId]),
  ...
});
if (cancelState?.cancelRequestedAtMs) {
  return yield* Effect.fail(new SmithersError("RUN_CANCELLED", ...));
}
```

`storage.queryOne` runs results through `transformRowKeys` -> `snakeToCamel` (packages/db/src/sql-message-storage.js:388-417), which only converts `_x`->`X`. Postgres folds the UNQUOTED alias `cancelRequestedAtMs` to lowercase `cancelrequestedatms`; `snakeToCamel("cancelrequestedatms")` has no underscores so it stays `cancelrequestedatms`. The result row therefore has key `cancelrequestedatms`, and `cancelState?.cancelRequestedAtMs` is ALWAYS `undefined` (falsy). The guard never fires on the Postgres backend.

The sqlite sibling at engine.js:1558-1561 reads via the raw bun:sqlite client (`client.query(...).get(runId)`), which preserves the alias case, so it works there. The comment at line 1355 ("Re-check cancellation inside the transaction (matches the sqlite path)") states the intent the Postgres path fails to meet.

Impact: the inner re-check exists to close the race where a run is cancelled AFTER the outer pre-transaction check (line 1459) but before the handoff commits. On Postgres that race window is unguarded: a run cancelled at that moment is still continued-as-new (child run spawned, source marked `continued`, RunContinuedAsNew event appended) instead of failing with RUN_CANCELLED.

**Fix:** Alias to snake_case and read the camelCased key, matching the rest of the codebase: `SELECT cancel_requested_at_ms FROM ...` then check `cancelState?.cancelRequestedAtMs` (snakeToCamel converts cancel_requested_at_ms -> cancelRequestedAtMs). Equivalently, double-quote the alias: `AS "cancelRequestedAtMs"`. Prefer the snake_case form for consistency with getRun and the other queries.

*Verifier:* Confirmed real. Line 1357 query uses unquoted camelCase alias `AS cancelRequestedAtMs`. Postgres/PGlite fold unquoted identifiers to lowercase, returning column `cancelrequestedatms`. transformRowKeys->snakeToCamel (sql-message-storage.js:418,436-447) only converts `_x`->`X`, so `cancelrequestedatms` (no underscores) stays as-is. The guard reads `cancelState?.cancelRequestedAtMs` (1360) which is always undefined on PG. Tellingly, every other query in this function deliberately uses lowercase aliases (e.g. `AS seq` at 1438, read as `seqRow?.seq`). The sqlite path (1558-1560) uses the raw bun:sqlite client which preserves alias case, so it works there. The in-transaction cancellation re-check is dead on Postgres.

### 91. [MEDIUM · data-loss] `packages/engine/src/engine.js:2815`

**Data-less liveness heartbeats clobber a queued-but-unflushed checkpoint payload, nulling the durable resume data in the DB**

In queueHeartbeat, the pending payload fields are overwritten unconditionally regardless of whether `data` was supplied:

```js
let heartbeatDataJson = null;
...
if (data !== undefined) { heartbeatDataJson = serialized.heartbeatDataJson; ... }
...
heartbeatPendingDataJson = heartbeatDataJson;   // <- always, even when data===undefined
heartbeatPendingDataSizeBytes = dataSizeBytes;
heartbeatHasPendingWrite = true;
```

Data-bearing heartbeats carry the durable resume checkpoint: `recordInternalHeartbeat({agentEngine, agentResume})` (line 3456) and `recordInternalHeartbeat({agentEngine, agentConversation})` (line 3350). Data-less liveness pings fire on EVERY stdout/stderr chunk and on most agent events (`emitOutput`->`recordInternalHeartbeat()` line 3132, `onStdout`/`onStderr` lines 3625/3630, `handleAgentEvent` else branch line 3462, `handleSdkStepFinish` line 3492).

Because writes are throttled (TASK_HEARTBEAT_THROTTLE_MS=500), a data-bearing checkpoint is queued and (if within the throttle window) sits in `heartbeatPendingDataJson` waiting to flush. Any data-less ping in that window resets `heartbeatPendingDataJson = null`, so when the throttled flush finally runs it persists null via `adapter.heartbeatAttempt(... heartbeatDataJson)` -> `updateWhere(_smithers_attempts, {heartbeatDataJson:null})` (db/src/adapter.js:1433), overwriting the row's `heartbeat_data_json`. Since stdout streaming is continuous, the steady-state persisted value is null: the captured `agentResume` session id (and conversation) is lost. On crash-resume, `previousHeartbeat` (line 2671) scans `heartbeat_data_json` and finds null for the crashed in-progress attempt (its metaJson was written at line 3279 BEFORE generate, so it carries agentResume=null too), so the agent cannot resume its native session and starts fresh.

**Fix:** Only mutate the pending data fields when a payload is actually supplied. Guard with `if (data !== undefined) { heartbeatPendingDataJson = heartbeatDataJson; heartbeatPendingDataSizeBytes = dataSizeBytes; }` and always update `heartbeatPendingAtMs`/`heartbeatHasPendingWrite`. This preserves the last queued checkpoint across liveness-only pings.

*Verifier:* Confirmed real and impactful. In queueHeartbeat, `heartbeatPendingDataJson = heartbeatDataJson` (2815) runs unconditionally; when data===undefined heartbeatDataJson stays null (2792), so a data-less liveness ping clobbers a queued-but-throttled data-bearing checkpoint to null. The overwrite happens even when a flush timer is already pending (the `if (!heartbeatWriteTimer)` only gates the flush call, not the assignment). The throttled flush then persists null via adapter.heartbeatAttempt, which does updateWhere(_smithers_attempts,{heartbeatDataJson}) UNCONDITIONALLY (adapter.js:1432-1436), erasing even a previously-persisted checkpoint. Data-less pings fire on every stdout/stderr chunk (3625/3630) and most events, so steady-state heartbeat_data_json is null and crash-resume's previousHeartbeat (2671) finds no agentResume/agentConversation. Breaks mid-execution native-session resume, which contradicts the extensive resume machinery (e.g. checkpointResumeSession at 3185).

### 92. [MEDIUM · concurrency] `packages/engine/src/engine.js:4024`

**Compute-task timeout neither cancels the running compute nor clears its timer**

In the compute branch the timeout is implemented as a `Promise.race` against a bare `setTimeout`:
```js
if (desc.timeoutMs) {
  races.push(new Promise((_, reject) => setTimeout(() => reject(new SmithersError("TASK_TIMEOUT", ...)), desc.timeoutMs)));
}
const abort = abortPromise(taskSignal);
if (abort) races.push(abort);
payload = await Promise.race(races);
```
Two concrete defects: (1) When the timeout wins, only the race is rejected — `taskSignal` is NOT aborted (unlike the heartbeat watchdog at line 2954 which calls `taskAbortController.abort(timeoutError)`). The underlying `desc.computeFn()` promise is orphaned and keeps executing. Since `computeFn` runs real git/shell work on the (possibly shared) worktree, and the timed-out attempt is then failed and retried, the orphaned compute can still be mutating the worktree concurrently with the new attempt → working-tree/index corruption. The compute also can't self-cancel because the timeout never flips the ambient signal. (2) When the compute wins the race instead, the `setTimeout` is never `clearTimeout`'d, so a pending timer (up to `desc.timeoutMs`) remains, keeping the event loop alive and delaying process exit after the workflow completes.

**Fix:** Capture the timer id and `clearTimeout` it in a `finally` after the race settles; and on timeout call `taskAbortController.abort(timeoutError)` (or otherwise signal the compute) so the orphaned compute stops touching the worktree.

*Verifier:* Confirmed both defects. The compute branch (4009-4034) races computePromise against a bare setTimeout (4024) and abortPromise. (1) When the timeout wins it only rejects the race; it never calls taskAbortController.abort(), unlike the heartbeat watchdog at 2954. desc.computeFn() (which runs real git/shell on a possibly-shared worktree) is orphaned and keeps executing while the failed attempt is retried -> concurrent worktree mutation. (2) The setTimeout is never cleared when compute wins, leaving a non-unref'd timer pending up to desc.timeoutMs that keeps the event loop alive. Both real; only applies when a compute task sets timeoutMs.

### 93. [MEDIUM · logic] `packages/engine/src/engine.js:4509`

**Auth circuit-breaker over-matches arbitrary agent output, permanently disabling a healthy agent**

The circuit-breaker builds `errStr` from the error message PLUS the agent's full textual output: `const errStr = String(effectiveError?.message ?? effectiveError ?? "") + (responseText ?? "");` and then tests it with `/invalid_authentication|401|api.key.*invalid|expired.*credentials|authentication.*failed/i`. Two problems compound: (1) `responseText` is the agent's raw, arbitrary output (often large for coding agents), and (2) the patterns are extremely loose. The bare alternative `401` matches that substring anywhere (e.g. a line number `line 401`, a port `4011`, a hash, `HTTP 401` mentioned in code under review), and `api.key.*invalid` / `authentication.*failed` use `.*` greedily across the whole blob (e.g. agent prose like "the api key handling here is invalid"). When matched, `disabledAgents.add(effectiveAgent)` runs. As confirmed at line 3122 (`allAgents.filter((a) => !disabledAgents.has(a))`), a disabled agent is removed from candidate selection for the REST of the run. So a single failed attempt whose output merely mentions "401" or contains the loose phrases falsely disables an otherwise-working agent, and a single-agent run can then be starved of any agent and fail.

**Fix:** Match auth signals only against the structured error (code/message), not the agent's free-text output, or tighten the patterns (e.g. word-boundary `\b401\b` paired with auth context, and anchor `invalid_authentication`/`api key invalid` rather than `.*`). Prefer keying off SmithersError codes/details over regex on stdout.

*Verifier:* Confirmed over-matching. Line 4506-4509 builds errStr = error message + responseText (the agent's full raw output) and tests `/invalid_authentication|401|api.key.*invalid|expired.*credentials|authentication.*failed/i`. The bare `401` alternative matches that substring anywhere (line 401, port 4011, 'HTTP 401' in reviewed code), and the `.*` patterns span the whole blob. On match, disabledAgents.add(effectiveAgent) (4511) permanently removes the agent from candidate selection (filter at 3122), so a single failed attempt whose output merely mentions 401 can starve a single-agent run. Only fires on an already-failed attempt, so situational, but the regex is genuinely too loose against arbitrary agent output.

### 94. [MEDIUM · concurrency] `packages/engine/src/engine.js:5942`

**Cancelled error-path overwrites run row without checking runOwnedByCurrentProcess**

In the top-level catch, the abort/cancelled branch unconditionally writes the run row:

```
if (runAbortController.signal.aborted || isAbortError(err)) {
  ...
  await Effect.runPromise(adapter.updateRun(runId, {
    status: "cancelled", finishedAtMs: nowMs(), heartbeatAtMs: null,
    runtimeOwnerId: null, cancelRequestedAtMs: null,
    hijackRequestedAtMs: null, hijackTarget: null,
    errorJson: JSON.stringify(hijackError),
  }));
```

The sibling 'failed' branch right below it (line 5978) correctly guards every DB mutation with `if (runOwnedByCurrentProcess)`. `runOwnedByCurrentProcess` only becomes true at lines 5637/5641/5664 (after insertRun / activateRunForResume / updateRun). Any error thrown in the window between the start of the try (getRun at 5509) and ownership acquisition — e.g. `assertResumeDurabilityMetadata` (5572), input validation (5585), or simply a pre-aborted `opts.signal` wired at 4858 firing during the early DB reads — lands here with `runOwnedByCurrentProcess === false`. If `opts.signal` is already aborted, this branch then rewrites an existing run row that this process never claimed: it sets status=cancelled, clears `runtimeOwnerId`, `heartbeatAtMs`, `cancelRequestedAtMs`, and the hijack fields. If that run is actively owned/heartbeating in another process, its ownership and pending cancel/hijack state are clobbered and it is marked cancelled while still executing elsewhere. The failed path was deliberately guarded to avoid exactly this; the cancelled path was not.

**Fix:** Gate the DB mutations in the cancelled branch on `runOwnedByCurrentProcess`, mirroring the failed branch: only call adapter.updateRun / emit RunCancelled when this process owns the run; otherwise just annotate the span and return {runId, status: "cancelled"}.

*Verifier:* Confirmed asymmetry. The cancelled branch (5942-5964) calls adapter.updateRun unconditionally (status=cancelled, runtimeOwnerId=null, heartbeatAtMs=null, cancelRequestedAtMs=null, hijack fields=null), while the sibling failed branch guards every mutation with `if (runOwnedByCurrentProcess)` (5978). runOwnedByCurrentProcess only becomes true at 5637/5641/5664. wireAbortSignal (1873-1875) immediately aborts runAbortController when opts.signal is already aborted, so a pre-aborted signal plus any error thrown in the early window (getRun 5509, assertResumeDurabilityMetadata 5572, input validation 5585, restoreDurableStateFromSnapshot 5594) lands in the cancelled branch with runOwnedByCurrentProcess=false. On a resume of a run actively owned/heartbeating by another process, this clobbers that process's ownership and pending cancel/hijack state and marks it cancelled while it still executes. Narrow window but the guard was deliberately added to the failed path and is missing here.

### 95. [MEDIUM · correctness] `packages/engine/src/external/json-schema-to-zod.js:68`  _(corroborated ×2)_

**array and boolean schemas ignore `nullable` and `default`; object ignores `default`**

`convertNode` applies the OpenAPI-style `nullable` keyword and `default` consistently for strings and numbers (via `maybeNullable(maybeDefault(...))` in `buildString`/`buildNumber`), but the boolean and array branches skip both, and `buildObject` skips `default`:

- boolean (line 67): `return maybeDescribe(z.boolean(), node);` — no `maybeDefault`, no `maybeNullable`.
- array (lines 68-71): `const items = convertNode(node.items, ...); return maybeDescribe(z.array(items), node);` — no `maybeDefault`, no `maybeNullable`.
- object (line 148): `return maybeDescribe(maybeNullable(obj, s), s);` — applies nullable but not `default`.

Concrete failures: a schema `{type:"array", nullable:true}` produces a plain `z.array(...)` that REJECTS `null` (verified with Zod 4.3.6: `z.array(z.string()).safeParse(null).success === false`), so an agent legitimately returning `null` for a nullable-array field fails validation and errors the run. Likewise `{type:"boolean", default:false}` or `{type:"array", default:[]}` silently drop the default, so an omitted optional field stays `undefined` instead of being filled — different behavior than the equivalent string/number field. This is an inconsistency oversight (the authors clearly intend `nullable`/`default` support since they wired it for string/number).

**Fix:** Wrap the boolean/array results and the object result the same way as numbers/strings, e.g. `return maybeDescribe(maybeNullable(maybeDefault(z.boolean(), node), node), node);`, `... maybeDefault(z.array(items), node) ...`, and add `maybeDefault` to the `buildObject` return.

*Verifier:* Confirmed in code: boolean branch (line 67) returns `maybeDescribe(z.boolean(), node)` with no maybeNullable/maybeDefault; array branch (line 70) returns `maybeDescribe(z.array(items), node)` with neither; buildObject (line 148) applies maybeNullable but never maybeDefault, whereas buildString (115) and buildNumber (129) wire both via `maybeNullable(maybeDefault(...))`. Verified at runtime: `{type:'array',nullable:true}` rejects null (safeParse(null).success===false); an object property `{type:'boolean',default:false}` is NOT filled when omitted (result {}), and neither is `{type:'array',default:[]}` (result {}), while the equivalent `{type:'number',default:7}` IS filled (result {n:7}). So a legitimate null for a nullable-array field fails validation (HUMAN_REQUEST_VALIDATION_FAILED in human-requests.js), and boolean/array/object defaults are silently dropped, inconsistent with string/number. Real correctness defect.

### 96. [MEDIUM · error-handling] `packages/engine/src/startDocFileSync.js:74`

**Doc-sync failure produces an unhandled promise rejection (fire-and-forget runSync never gets a catch in time)**

`runSync` builds `chain = chain.catch(()=>...).then(() => syncDocsFromDisk(...))` and returns that promise. The `.catch(...)` only guards the PREVIOUS chain link; the rejection produced by the new `syncDocsFromDisk(...)` call is the value stored in `chain` and is NOT handled at creation time. The watcher path calls it as `void runSync(paths)` (line 67-68) and the startup path as `void runSync(undefined)` (line 73), both discarding the returned promise. A `.catch` is only attached to that rejected promise on the *next* runSync invocation, which happens on a later filesystem-settle macrotask. So if `adapter.upsertDocRow` (or any non-ENOENT readFile error) makes `syncDocsFromDisk` reject, the promise is unhandled at the microtask checkpoint -> Node/Bun fires `unhandledRejection` (noisy warning, and a process crash under strict rejection handling). The error is also silently lost. This is reachable whenever SMITHERS_DOCS_FILE_SYNC=1 and a DB write fails during a settle.

**Fix:** Attach a terminal catch to the fire-and-forget invocations, e.g. `void runSync(paths).catch(() => {})` at lines 67-68 and 73, or have runSync swallow/log its own rejection internally before returning a resolved summary.

*Verifier:* Confirmed in real code. runSync (startDocFileSync.js:52-62) does chain = chain.catch(...).then(() => syncDocsFromDisk(...)); the leading .catch only handles the PREVIOUS chain link. The new promise stored in chain (and returned) has no rejection handler attached. Both fire-and-forget callers discard it: watcher onSettle `void runSync(paths)` (line 67) and startup `void runSync(undefined)` (line 73). A handler is attached to that rejected promise only on the NEXT runSync's leading .catch or on stop()'s `await chain.catch()` (line 82), which happens in a later macrotask. syncDocsFromDisk genuinely rejects: throw error at line 215 for non-ENOENT errors after `await adapter.upsertDocRow` (line 196), an uncaught `await adapter.upsertDocRow` in the ENOENT branch (line 210), and absoluteDocPath throwing on traversal (line 184, outside the try). So with SMITHERS_DOCS_FILE_SYNC=1 (wired at engine.js:3570) and a DB write failure during a sparse settle or the startup sync, the rejected promise sits unhandled in the window before the next runSync -> unhandledRejection fires and the error is silently lost. The sibling helpers emitWatcherDrop (line 24) and emit (line 67) use .catch(() => {}) precisely to avoid this; runSync omits it. Medium severity: opt-in flag plus a write failure required, noisy on Bun, swallowed error, possible crash under strict rejection handling.

### 97. [MEDIUM · correctness] `packages/gateway-client/src/sync/createElectricCollection.ts:313`  _(corroborated ×2)_

**Electric ShapeStream opened without replica:'full' — UPDATE rows arrive partial, corrupting/dropping data**

The ShapeStream is constructed with only `table`, `where`, and `params` (whereParams) — no `replica` parameter (grep for "replica" across gateway-client/src and server/src returns nothing). Electric's default shape `replica` mode is `'default'`, which on an UPDATE sends ONLY the changed columns plus the primary key, not the full row. But this code uses `rowUpdateMode: "full"` and reconstructs the entire stored row from each raw Electric `value` via `def.mapRow(message.value)` (line 263). The header comment (lines 14-22) explicitly assumes "Electric delivers each row as `{ value: { <snake_case columns> } }`" with every column present. Under default replica this breaks for updates, with two concrete failures in the only registered def (`mapMemoryFactRow` in electricCollectionDefs.ts): (1) a partial update that omits an unchanged `value_json` makes `mapMemoryFactRow` return `undefined` (it requires `typeof valueJson === "string"`), so the update is silently dropped at line 264 `if (mapped === undefined) continue;` and the row stays stale; (2) a partial update that omits unchanged `created_at_ms` makes `asMs(raw.created_at_ms)` return its 0 fallback, overwriting the real `createdAtMs` with epoch-0 — the same '*_ms fell through to 0' symptom the electricCollectionDefs comment (lines 18-25) attributes only to the int8/bigint parser, re-introduced on every partial update. Net: live cloud-Electric edits render with wrong/epoch timestamps or never update, while the gateway-transport path is unaffected.

**Fix:** Pass `replica: "full"` in the ShapeStream `params` (e.g. `params: { table: def.table, replica: "full", ...where, ...whereParams }`) so every change message carries the complete row, matching the `rowUpdateMode: "full"` contract and mapRow's full-column assumption.

*Verifier:* Confirmed. The ShapeStream in createElectricCollection.ts (lines 311-322) is constructed with only url/params(table,where,params)/headers/signal — no `replica`. The installed @electric-sql/client index.d.ts (lines 421-432) documents: "If `replica` is `default` (the default) then Electric will only send the changed columns in an update. If it's `full` Electric will send the entire row." So under the default, UPDATE messages carry only changed columns + PK. The code uses `rowUpdateMode:"full"` (line 183) and rebuilds the full stored row from each raw value via def.mapRow(message.value) (line 263), and the header comment (lines 14-22) explicitly assumes every column is present. In the only registered def (mapMemoryFactRow, electricCollectionDefs.ts:55-71): (1) an update that does NOT change value_json omits it → mapMemoryFactRow returns undefined (it requires typeof valueJson==="string", line 59) → dropped at createElectricCollection.ts:264, leaving the row stale; (2) created_at_ms never changes on an update so it is omitted → asMs(raw.created_at_ms) hits its 0 fallback (electricCollectionDefs.ts:33) → createdAtMs overwritten to epoch-0, plus schemaSig/ttlMs reset to null. This is exactly the '*_ms fell through to 0' symptom the def comment warns about, re-introduced on every partial update. Real correctness/data-corruption bug, scoped to the cloud-Electric path only (gateway transport unaffected), so medium.

### 98. [MEDIUM · performance] `packages/gateway-client/src/sync/createGatewayCollection.ts:119`

**Asymmetric withoutVirtualFields comparison flags every node row as changed each snapshot refetch**

`withoutVirtualFields` (packages/gateway-client/src/sync/withoutVirtualFields.ts) strips `$`-prefixed and `undefined`-valued keys from a row. The change-detection sites apply it to only ONE side of the comparison: `shouldWriteUpdate` does `!deepEquals(withoutVirtualFields(current), row)` (createGatewayCollection.ts:119), and `reconcileSnapshotNodes` does `!deepEquals(withoutVirtualFields(current), row)` (reconcileSnapshotNodes.ts:24). The freshly-produced `row` is NOT normalized. For the `nodes` collection the rows come from `flattenGatewayRunNode`, which always emits `children: undefined` (flattenGatewayRunNode.ts: `children: undefined`). `@tanstack/db`'s `deepEquals` compares objects by `Object.keys(a).length !== Object.keys(b).length` then `key in b`, and `Object.keys` includes keys whose value is `undefined`. So `withoutVirtualFields(current)` drops the `children` key (5 keys) while `row` keeps `children: undefined` (6 keys), and they NEVER compare equal even when content is identical. I verified this directly: for two flatten outputs of the same tree, `deepEquals(withoutVirtualFields(current), next)` returns `false`. Result: every devtools-snapshot refetch (replace mode) writes an `update` for EVERY node, producing the full-tree churn the gatewayCollectionDefs.ts comment explicitly claims to avoid ("writes only the rows that actually changed ... rather than a full-tree churn"). Reactive consumers re-render all nodes on every frame.

**Fix:** Normalize both operands: `!deepEquals(withoutVirtualFields(current), withoutVirtualFields(row))` in both shouldWriteUpdate (createGatewayCollection.ts:119) and reconcileSnapshotNodes (reconcileSnapshotNodes.ts:24); equivalently, stop emitting `children: undefined` in flattenGatewayRunNode (omit the key instead).

*Verifier:* Confirmed by reading the real code and empirically reproducing. createGatewayCollection.ts:119 `shouldWriteUpdate` does `!deepEquals(withoutVirtualFields(current), row)` — withoutVirtualFields (withoutVirtualFields.ts:7) drops keys whose value is `undefined`, but is applied to ONLY `current`, not the freshly-produced `row`. The `nodes` collection (gatewayCollectionDefs.ts:107-127) uses `refetchMode: "replace"` → replaceRows → shouldWriteUpdate, and its rows come from snapshotRows→flattenGatewayRunNode (flattenGatewayRunNode.ts:16) which always emits `children: undefined`. @tanstack/db deepEquals (node_modules .../db/dist/esm/utils.js:91-96) returns false when `Object.keys(a).length !== Object.keys(b).length`, and Object.keys includes keys with undefined values. So the left side (5 keys, children stripped) never equals the right side (6 keys, children:undefined), making shouldWriteUpdate always return true. I ran it with @tanstack/db 0.6.8: deepEquals(withoutVirtualFields(current), row) returns false for two identical-content flatten rows, while the symmetric control (both normalized) returns true. Result: every streamDevTools refetch writes an update for EVERY node, defeating the 'writes only the rows that actually changed ... rather than a full-tree churn' optimization the comment at gatewayCollectionDefs.ts:116-118 claims. Same asymmetry exists at reconcileSnapshotNodes.ts:24. Impact is performance/re-render churn, not data loss, so medium is appropriate.

### 99. [MEDIUM · correctness] `packages/gateway-client/src/sync/flattenGatewayRunNode.ts:16`

**flattenGatewayRunNode emits `children: undefined`, defeating node-collection change detection (full-tree rewrite every DevTools frame)**

flattenGatewayRunNode builds each row as `{ ...node, ...(parentId ? { parentId } : {}), childIds, children: undefined }`. The explicit `children: undefined` assignment makes `children` an OWN enumerable key (it appears in `Object.keys(row)`), even though its value is undefined.

Change detection compares this row asymmetrically. In `createGatewayCollection.ts` `shouldWriteUpdate` does `!deepEquals(withoutVirtualFields(current), row)`, and `withoutVirtualFields` (withoutVirtualFields.ts: `if (!key.startsWith("$") && value !== undefined)`) DROPS the `children` key from `current` because its value is undefined — but the freshly-flattened `row` is passed in WITHOUT that normalization, so it still carries the `children` key. `@tanstack/db@0.6.8` `deepEquals` (src/utils.ts) returns false whenever `Object.keys(a).length !== Object.keys(b).length`. Stripped-`current` has one fewer key than `row`, so `deepEquals` always returns false → `shouldWriteUpdate` always returns true.

The `nodes` collection (gatewayCollectionDefs.ts `nodes`, refetchMode:"replace") therefore rewrites an `update` for EVERY node in the run tree on EVERY streamDevTools frame (each frame triggers a full `getDevToolsSnapshot` refetch → `replaceRows` → `shouldWriteUpdate` per node), even when nothing changed. This directly violates the documented contract in gatewayCollectionDefs.ts ("writes only the rows that actually changed ... rather than a full-tree churn"), causing every reactive consumer to re-render the entire tree on every frame. The exported `reconcileSnapshotNodes` (reconcileSnapshotNodes.ts:24) has the identical asymmetry (`deepEquals(withoutVirtualFields(current), row)` with un-normalized `row`) and likewise emits a spurious update for every matching node.

**Fix:** Omit the `children` key entirely in flattenGatewayRunNode instead of setting it to undefined (e.g. destructure it out: `const { children: _omit, ...rest } = node; rows.push({ ...rest, ...(parentId ? { parentId } : {}), childIds });`). Alternatively, normalize the comparison row in both call sites (`shouldWriteUpdate` and `reconcileSnapshotNodes`) by comparing `withoutVirtualFields(row)` so both sides are stripped symmetrically.

*Verifier:* Confirmed in real code and empirically. flattenGatewayRunNode.ts:16 sets `children: undefined` as an own enumerable key on every row (Object.keys includes it). shouldWriteUpdate (createGatewayCollection.ts:117-119) compares withoutVirtualFields(current) against the un-normalized row; withoutVirtualFields.ts:7 drops the undefined-valued `children` key from `current` only. @tanstack/db@0.6.8 deepEquals (dist/esm/utils.js:91-96) returns false when Object.keys(a).length !== Object.keys(b).length, so normalized `current` (N-1 keys) never equals `row` (N keys) -> shouldWriteUpdate always returns true. My repro printed keys norm(stored)=[id,status,childIds,parentId] vs keys fresh=[...,children] and deepEquals=false even for an unchanged node. The nodes collection (gatewayCollectionDefs.ts:120-126, refetchMode:'replace') runs replaceRows->shouldWriteUpdate per node on every streamDevTools refetch, so it emits a spurious update for every node every frame, defeating the documented 'writes only the rows that actually changed' contract (gatewayCollectionDefs.ts:116-118). reconcileSnapshotNodes.ts:24 has the identical asymmetry. Impact is unnecessary full-tree re-render churn (perf/correctness), not a crash, so medium severity is right.

### 100. [MEDIUM · error-handling] `packages/gateway-react/src/useGatewayRuns.ts:23`

**Live list/single hooks hard-code error: undefined, silently swallowing backend RPC failures**

Every live-collection hook returns `error: undefined` unconditionally: useGatewayRuns (line 23-24), useGatewayWorkflows, useGatewayApprovals, useGatewayCrons, useGatewayMemoryFacts, useGatewayPrompts, useGatewayScores, useGatewayTickets, and useGatewayRun all do `return { data, error: undefined, loading: !live.isReady && data.length === 0, refetch }`. The underlying collection swallows fetch failures too: in packages/gateway-client/src/sync/createGatewayCollection.ts `loadInitial()` catches the error (line 348) and only invokes the optional `config.onError` callback, then calls `markReady()` in the `finally` (line 354) REGARDLESS of failure. The registry's `knownCollection` (createGatewayCollections.ts) never wires an `onError`, so the error is dropped entirely (not even logged). Net effect: when e.g. `listApprovals` or `listRuns` fails on the backend, `live.isReady` flips true, `data` is `[]`, `loading` becomes false, and `error` stays undefined — the UI renders an empty list indistinguishable from a genuine 'no data' state. For approvals this hides a run stuck on a pending gate; for runs/workflows it hides that the gateway is down. Notably useGatewayRunEvents DOES read `live.isError`, showing the author considers that signal meaningful, but these hooks ignore it and any error path.

**Fix:** Surface the failure: read `live.isError` (and/or wire `onError` into knownCollection to capture the last error per collection) and return a real Error from these hooks instead of hard-coding `error: undefined`, so consumers can distinguish 'empty' from 'failed'.

*Verifier:* Confirmed in real code. useGatewayRuns.ts line 23 hardcodes error: undefined and ignores live.isError (which useLiveQuery does expose, as useGatewayRunEvents.ts:65 and useGatewayRunTree.ts:54 both read it). In createGatewayCollection.ts, loadInitial() (lines 339-357) catches the fetch error, calls handleError, then unconditionally calls markReady() in finally. handleError (159-165) only forwards to config.onError?/onAuthError? and there is no markFailed/error-status on the collection. The registry path knownCollection (createGatewayCollections.ts 298-326) constructs the config WITHOUT wiring onError/onAuthError, so for list collections (runs/approvals/etc.) the error is dropped entirely (not even logged). Net effect: on a backend listRuns failure, live.isReady becomes true, data is [], loading false, error undefined — a failure is indistinguishable from a genuine empty list (hides gateway-down / stuck pending approvals). Real error-handling defect; medium severity since it causes wrong UI state but no crash/data loss.

### 101. [MEDIUM · correctness] `packages/openapi/src/jsonSchemaToZod.js:64`

**nullable and default ignored for boolean/array schemas (and default for object)**

buildString (line 112) and buildNumber (line 129) both run the value through `maybeNullable(maybeDefault(...))`, so `nullable` and `default` are honored. But the boolean branch returns `maybeDescribe(z.boolean(), s)` (line 65), the array branch returns `maybeDescribe(z.array(items), s)` (line 69), and buildObject returns `maybeDescribe(maybeNullable(obj, s), s)` (line 159) — i.e. boolean and array drop BOTH `nullable` and `default`, and object drops `default`. Concrete failures: (a) a param/property declared `{type:"boolean", nullable:true}` produces a non-nullable `z.boolean()`, so when the LLM supplies `null` (legal per the spec) tool-input validation rejects it; same for `{type:"array", nullable:true}`. (b) a schema with a `default` on a boolean/array/object silently loses it, so an omitted optional arg is sent with no value (executeRequest skips `undefined`) instead of the spec-declared default, changing the upstream request.

**Fix:** Wrap the boolean, array, and object builders in the same `maybeDescribe(maybeNullable(maybeDefault(schema, s), s), s)` chain used by buildString/buildNumber so nullable and default apply uniformly across all types.

*Verifier:* Confirmed in code. buildString (line 112) and buildNumber (line 129) both end with maybeDescribe(maybeNullable(maybeDefault(schema, s), s), s), honoring nullable and default. But the boolean branch (line 65) returns only maybeDescribe(z.boolean(), s), and the array branch (line 69) returns only maybeDescribe(z.array(items), s) — neither calls maybeNullable nor maybeDefault. buildObject (line 159) returns maybeDescribe(maybeNullable(obj, s), s) — applies nullable but never maybeDefault. So {type:'boolean',nullable:true} and {type:'array',nullable:true} yield non-nullable schemas (reject a legal null), and default on boolean/array/object is silently dropped. The helpers maybeNullable (204) and maybeDefault (214) read s.nullable and s.default and are correct; they are simply not invoked on these branches. Real correctness defect from inconsistent builder wiring; medium severity given default-loss can change upstream requests, though the affected combos are somewhat narrow.

### 102. [MEDIUM · correctness] `packages/openapi/src/tool-factory/_helpers.js:188`

**Array query/path parameters are comma-joined via String() instead of OpenAPI form/explode serialization**

In executeRequest, every parameter value is coerced with `const strValue = String(value);` (line 188) and then placed into a single query slot via `fullUrl.searchParams.set(key, value)` (buildUrl line 70). For array-typed parameters the LLM/tool supplies a JS array, and `String(["a","b"])` produces the string "a,b". The OpenAPI default for query arrays is style=form, explode=true, which serializes as repeated keys `?key=a&key=b`. No code anywhere in packages/openapi reads `style`/`explode` (confirmed by grep — only set() is used, never append()). So any operation with an array query parameter (a very common case, e.g. `ids[]`, `tags`, `status`) is sent as a single comma-joined value, which most REST APIs reject or misinterpret, producing wrong results or 4xx errors. Path-array parameters have the same flaw.

**Fix:** Detect array values in the parameter bucketing loop and serialize per the parameter's style/explode (default: append each element as a repeated query key via searchParams.append; for path params join per style). At minimum, for query arrays use `for (const v of value) queryParams... ` with append semantics instead of a single String() coercion.

*Verifier:* executeRequest line 188 coerces every param value with String(value) before bucketing into queryParams, and buildUrl line 70 uses fullUrl.searchParams.set(key,value) — never append(). jsonSchemaToZod.js:67-69 supports array params (z.array), so an LLM can supply a JS array. Verified: URLSearchParams set('ids', String(['a','b'])) yields `ids=a%2Cb` (comma-joined), not the OpenAPI form/explode=true default of repeated `ids=a&ids=b`. No style/explode handling exists. Real correctness bug for array query parameters. Note: for path arrays the default style is 'simple' (comma-separated), so String() coincidentally matches there; the query-array case is the genuine defect.

### 103. [MEDIUM · correctness] `packages/openapi/src/tool-factory/_helpers.js:372`  _(corroborated ×2)_

**Relative server URL makes every generated tool call fail with "Invalid URL"**

resolveBaseUrl falls back to `spec.servers[0].url` (line 372). Many real OpenAPI 3.0 specs use a relative server URL — the canonical Swagger Petstore v3 spec literally declares `servers: [{ url: "/api/v3" }]`. buildUrl then does `const fullUrl = new URL(baseUrl);` (line 64). `new URL("/api/v3")` throws `TypeError: Invalid URL` (confirmed by running it against the project's runtime). The throw is caught by the tool's execute() and surfaced as `{error:true, message:"Invalid URL"}`, so EVERY call of EVERY generated tool fails whenever the user does not pass an explicit `baseUrl` and the spec's first server URL is relative. The code clearly intends servers[0].url to be a usable base, so silently breaking on the most common spec shape is a real defect.

**Fix:** In resolveBaseUrl or buildUrl, treat a relative server URL as relative: if `new URL(baseUrl)` fails (or the url doesn't start with http), resolve it against the spec origin / a configured origin, or require/validate an absolute baseUrl and emit a clear error naming the offending server URL instead of an opaque 'Invalid URL'.

*Verifier:* resolveBaseUrl (line 372-373) returns spec.servers[0].url verbatim; buildUrl line 64 does `new URL(baseUrl)`. Verified at runtime in Bun: `new URL("/api/v3")` throws 'cannot be parsed as a URL'. No normalization of relative server URLs exists anywhere (grep shows servers[] only referenced in resolveBaseUrl). createToolFromOperation's execute() catch (line 351-359) converts the throw into {error:true,message,status:'failed'}. So when no explicit baseUrl is passed and the spec's first server is relative (Petstore v3 uses `/api/v3`), every generated tool call fails. Real defect; medium since mitigable by passing baseUrl, and the per-request crash is reachable through the shipped createOpenApiToolsFromSpec entry.

### 104. [MEDIUM · error-handling] `packages/pi-plugin/src/api/SmithersPiHttpClient.ts:60`

**events() silently swallows non-OK HTTP responses, masking run-not-found / auth failures as an empty stream**

In `events()`:

```
const res = await fetch(`${this.baseUrl}${path}`, { headers: buildHeaders(this, false) });
if (!res.ok || !res.body) {
  return;
}
```

When the server responds with a non-2xx status the generator returns immediately and yields nothing. The SSE event route on the server returns JSON 404 (`sendJson(res, 404, {error:{code:'NOT_FOUND'...}})`) when the run does not exist, and a 401 when auth fails. Unlike `json()` (which throws a `SmithersError` on `!res.ok`), `events()`/`streamEvents()` give the caller no way to distinguish 'this run has no events / the stream ended normally' from 'run not found' or 'unauthorized'. A consumer iterating `streamEvents({runId})` for a bad runId or with a wrong apiKey will observe a clean empty iteration and conclude the run produced nothing, hiding the real failure. The in-loop comment ('Skip malformed SSE frames instead of aborting') concerns frame parsing, not this top-level early return, so this is not a documented design choice for transport errors.

**Fix:** On `!res.ok`, read the body text and throw a `SmithersError('PI_HTTP_ERROR', ...)` exactly like `json()` does, instead of returning silently. Only treat a genuinely missing `res.body` on a 2xx response as an empty stream.

*Verifier:* Confirmed in code: events() lines 60-62 `if (!res.ok || !res.body) return;` ends the generator silently with zero yields, while json() lines 41-52 throws SmithersError on !res.ok. streamEvents.ts simply does `yield* client.events(...)`, so a consumer passing a bad runId (server 404) or wrong apiKey (401) observes a clean empty iteration indistinguishable from a run with no events. The in-loop try/catch comment only covers per-frame JSON parse failures, not this top-level transport early-return. Genuine error-handling inconsistency that masks not-found/auth failures.

### 105. [MEDIUM · concurrency] `packages/pi-plugin/src/runtime/DevToolsClient.ts:251`

**waitForEvent timeout never fires when the socket is silent (permanent hang on connect)**

`waitForEvent` is supposed to bound the wait for `connect.challenge` to `timeoutMs` (called with 5_000 from `connect()`):

```
private async waitForEvent(event: string, timeoutMs: number) {
  const timeoutAt = Date.now() + timeoutMs;
  while (Date.now() < timeoutAt) {
    const frame = await this.nextEvent();
    if (!frame) { break; }
    if (frame.event === event) { return frame; }
  }
  throw new SmithersError("PI_GATEWAY_TIMEOUT", `Timed out waiting for ${event}.`);
}
```

The time check `Date.now() < timeoutAt` is only evaluated *between* awaits. `nextEvent()` returns a Promise that resolves only when a message arrives or the connection closes (it parks a resolver in `this.waiters` and is never settled by any timer). So if the gateway accepts the WebSocket but never sends `connect.challenge` (slow server, wrong endpoint, intervening proxy), `await this.nextEvent()` blocks forever and the loop's deadline is never re-checked. The advertised 5s timeout never triggers, so `connect()` -> `streamDevTools()` hangs indefinitely. Because the generator never yields and never throws, the consumer in DevToolsStore.consumeStream stays parked in its `for await` and never reconnects (the backoff/reconnect loop is only driven by the generator ending or throwing). Only an external abort signal (which closes the ws and drains the waiter with `undefined`) can break it.

**Fix:** Race the per-iteration wait against the remaining deadline, e.g. `const remaining = timeoutAt - Date.now(); const frame = await Promise.race([this.nextEvent(), new Promise(r => setTimeout(() => r(TIMEOUT_SENTINEL), remaining))]);` and treat the sentinel as a timeout (clearing the timer on resolve). Alternatively give `request()`/`nextEvent()` a real timeout.

*Verifier:* Confirmed in code. nextEvent() (lines 228-238) returns a Promise whose resolver is pushed to this.waiters and only settled by an inbound message or a close/error event (rejectAll->closeWaiters). waitForEvent (251-263) checks the deadline only between awaits, so when the gateway accepts the WS (open fires at line 203) but never sends connect.challenge and never closes, `await this.nextEvent()` blocks forever and the 5_000ms deadline (called from connect() line 210) is never re-checked; PI_GATEWAY_TIMEOUT never throws. The `ws` library has no default post-handshake idle timeout, so connect()->streamDevTools() hangs until an external abort (which closes the ws and drains the waiter). Mitigated only by AbortSignal, exactly as claimed; medium because a slow/wrong-endpoint server permanently parks the stream with no self-recovery.

### 106. [MEDIUM · error-handling] `packages/pi-plugin/src/runtime/DevToolsStore.ts:557`

**Decode-error recovery is silently reverted, causing an unrecoverable reconnect loop on a poison frame**

In `consumeStream`, when a stream event fails to decode the catch sets `nextAfterSeq = undefined` (line 549) — clearly intending to resync from scratch instead of resuming from the same cursor:

```
if (err.message.includes("DevTools event")) {
  this.decodeErrorCount += 1;
  nextAfterSeq = undefined;
}
```

The decode errors come from `normalizeEvent` which throws `SmithersError("PI_DEVTOOLS_DECODE_ERROR", "DevTools event must be an object.")` / `"Unknown DevTools event kind."` (DevToolsClient.ts:112,138), both of whose messages contain the substring "DevTools event". But immediately after the try/catch, line 557 reverts that intent:

```
nextAfterSeq = nextAfterSeq ?? this.lastSeenSeq(runId);
```

Since `lastSeenSeq` normally returns a concrete seq (the last successfully-applied seq, because the bad frame's seq was never recorded — the client only updates its cursor AFTER a successful `normalizeEvent`, DevToolsClient.ts:395), the next reconnect resumes from exactly the seq just before the undecodable frame. The server then re-sends the same poison frame, which throws again, and the loop repeats forever (backoff caps at 30s). `decodeErrorCount` climbs unboundedly and the UI never receives further updates. There is no mechanism to skip past the bad frame, so the explicit `undefined` reset is dead code.

**Fix:** Track whether the last failure was a decode error and, if so, force a full snapshot resync (call `requestResync(runId)` / pass a sentinel that the client honors as 'start from a fresh snapshot') rather than `nextAfterSeq ?? lastSeenSeq`. Guard the `??` so it does not clobber a deliberately-cleared cursor, e.g. only fall back to `lastSeenSeq` when the failure was a transient/connection error, not a decode error.

*Verifier:* The end-state defect is real: a deterministic poison frame produces an unrecoverable reconnect loop with no skip mechanism, and decodeErrorCount climbs unboundedly. Confirmed: normalizeEvent (DevToolsClient.ts:394) runs BEFORE lastSeqSeenByRunId.set (395), so the bad frame's seq is never recorded; the decode error message contains 'DevTools event' so the store's branch at line 547 fires and sets nextAfterSeq=undefined. Line 557 then does nextAfterSeq = undefined ?? this.lastSeenSeq(runId), which (when a prior good liveSnapshot exists, seq>0) returns the last good seq, so the reconnect re-requests the poison frame -> infinite loop. The reviewer's conclusion ('there is no mechanism to skip the bad frame; the undefined reset is dead code') is correct. Nuance: line 557 is not the sole cause -- even if the store honored undefined, streamDevTools line 334 (afterSeqCursor = afterSeq ?? this.lastSeqSeenByRunId.get(runId)) falls back to the client's own internal cursor = last good seq, so the loop would persist regardless. The only true from-scratch resync path is the gapResync/SeqOutOfRange branch (DevToolsClient.ts:359-366). So the defect is genuine but the fix is deeper than the single line cited.

### 107. [MEDIUM · data-loss] `packages/sandbox/src/bundle.js:99`

**Asymmetric size limits: writeSandboxBundle allows a >5MB diffBundle in README that validateSandboxBundle then rejects**

writeSandboxBundle serializes `diffBundle` directly into README.md (lines 210-216) and the only size guard at write time is estimateBundleWriteBytes/validateSandboxBundleWriteParams, which checks the TOTAL bundle against SANDBOX_MAX_BUNDLE_BYTES (100MB) — diffBundle is never bounded by assertJsonPayloadWithinBounds (only `output` is, lines 121-127). But validateSandboxBundle enforces a separate, much smaller README cap: `if (readmeStats.size > SANDBOX_MAX_README_BYTES)` (line 152, SANDBOX_MAX_README_BYTES = 5MB) and throws INVALID_INPUT "README.md exceeds 5242880 bytes". A diffBundle whose combined `patches[].diff` strings push the README between 5MB and 100MB will be WRITTEN successfully but FAIL its own validation on read. In execute.js this round-trip is real: materializeProviderResult calls writeSandboxBundle({ diffBundle: source.diffBundle }) (execute.js:217-226) and the same bundle is later validated via validateSandboxBundle (execute.js:481). A large but legitimate refactor diff (>5MB of unified diff is common) causes a successful child sandbox run to be discarded with an INVALID_INPUT error — the run's results are lost even though nothing is malicious or malformed.

**Fix:** Bound the README/diffBundle at write time consistent with the read-time cap: either run the JSON.stringified README through the SANDBOX_MAX_README_BYTES check inside validateSandboxBundleWriteParams (failing loudly before write), or raise/remove the 5MB README cap and rely on the 100MB total-bundle cap, and apply assertJsonPayloadWithinBounds to diffBundle the same way it is applied to output.

*Verifier:* Confirmed asymmetric size caps. writeSandboxBundle (bundle.js:210-216) serializes diffBundle directly into README.md JSON. Its only write-time guard is validateSandboxBundleWriteParams -> estimateBundleWriteBytes (lines 99-111), which includes diffBundle in readmeBytes (line 104) but checks the SUM against SANDBOX_MAX_BUNDLE_BYTES = 100MB (line 135). No 5MB README-specific cap and assertJsonPayloadWithinBounds only bounds `output` (lines 121-127), not diffBundle. validateSandboxBundle then enforces a separate 5MB cap at read: `if (readmeStats.size > SANDBOX_MAX_README_BYTES)` (line 152, 5*1024*1024) throwing INVALID_INPUT before even parsing. So a README between 5MB and 100MB writes successfully but fails its own read validation. The round-trip is real in execute.js: materializeProviderResult calls writeSandboxBundle({ diffBundle: source.diffBundle }) (execute.js:217-226) and the same path is validated via validateSandboxBundle at execute.js:481 (and again at 651/659). A legitimate large diffBundle (large refactor unified diffs in patches[].diff) therefore causes a successful sandbox run's results to be discarded with INVALID_INPUT. Severity medium is appropriate: real data loss but only triggered by diffBundle pushing README into the 5MB-100MB window.

### 108. [MEDIUM · concurrency] `packages/sandbox/src/effect/sandbox-entity.js:135`

**Sandbox cancellation AbortSignal is silently dropped on the transport execute path**

executeSandbox calls `sandboxTransport((svc) => svc.execute(resolveSandboxCommand(options.config?.command), sandboxHandle, runtime.signal))` (execute.js:610), and SandboxTransportService.execute is typed `(command, handle, signal?)`. But the entity layer wires execute as `execute: ({ payload }) => executor.execute(payload.command, payload.handle)` (sandbox-entity.js:135) and the service wrapper as `execute: (command, handle) => withClient(...)` (sandbox-entity.js:174) — neither forwards `signal`. The signal cannot cross the RPC payload boundary either (SandboxExecutePayloadSchema has only command+handle). So `spawnSandboxCommand` in process-runner.js always receives `signal: undefined`. The explicit comment in process-runner.js ("Forward the run's abort signal so a cancel/down SIGKILLs the (detached) sandbox process group instead of letting it run to the 10-minute timeout") is therefore dead: when a run is cancelled, the docker/bwrap/sandbox-exec process is NOT killed and runs until the 10-minute idle/total timeout. This is exactly the leak the code claims to fix.

**Fix:** The AbortSignal cannot be serialized through the cluster RPC entity. Either bypass the entity-client indirection for in-process runtimes and call the executor directly with the signal, or thread cancellation through Effect interruption (Effect.onInterrupt) so the spawned process is killed when the surrounding scope is interrupted.

*Verifier:* Same genuine defect as index 0, described from the cancellation angle and equally accurate. svc.execute is called with runtime.signal (execute.js:610), but the entity wiring at sandbox-entity.js:135 and the service wrapper at :174 never forward signal, and SandboxExecutePayloadSchema has no signal field so it cannot cross the RPC payload boundary. spawnSandboxCommand thus gets signal undefined, defeating the documented cancel-kill. The existing test (execute.test.js:202) only asserts the executeChildWorkflow signal path, not the transport execute path, so the drop is untested. Impact bounded by the command timeout, hence medium.

### 109. [MEDIUM · resource-leak] `packages/sandbox/src/effect/sandbox-entity.js:174`

**Sandbox abort signal dropped at transport boundary, leaving sandbox processes orphaned on cancel**

The transport service contract (`SandboxTransportService.execute: (command, handle, signal?: AbortSignal) => ...`) and the only caller (`execute.js:610` -> `svc.execute(resolveSandboxCommand(...), sandboxHandle, runtime.signal)`) explicitly thread the run's abort signal down to `execute`. But the service implementation drops it twice:

1. `sandbox-entity.js:174` — `execute: (command, handle) => withClient(handle, "execute", { command }, (client) => client.execute({ command, handle }))` destructures only two params and never references `signal`.
2. `sandbox-entity.js:135` — the entity handler `execute: ({ payload }) => executor.execute(payload.command, payload.handle)` calls the executor with only two args.

Consequently the `signal` parameter received by the executors in `http-runner.js:58` (`execute: (command, handle, signal) => spawnSandboxCommand("docker", dockerArgs(command, handle), { ..., signal })`) and `socket-runner.js:64` is ALWAYS `undefined`. `spawnSandboxCommand` therefore passes `signal: undefined` to `spawnCaptureEffect`, so the `signal.addEventListener("abort", kill)` path in `child-process.js:143-152` is never wired. This defeats exactly the fix documented at `process-runner.js:291-294` ("Forward the run's abort signal so a cancel/down SIGKILLs the (detached) sandbox process group... Without this the docker/bwrap/sandbox-exec command kept executing after the run was cancelled"). On `smithers cancel`/`down`, the detached docker `run`/bwrap/sandbox-exec process group is no longer SIGKILLed via the abort signal and continues running (up to the 10-minute default timeout), leaking processes/containers and continuing side effects.

**Fix:** Thread the signal through the in-process entity dispatch. Since AbortSignal is not RPC-serializable, attach it at the service layer rather than the payload: in `makeSandboxTransportServiceEffect`'s `execute` keep the third `signal` arg and convert run cancellation into Effect interruption of the entity call (e.g. wrap with `Effect.raceFirst`/`Effect.interruptible` driven by the signal), or bypass the entity for execute and call `executor.execute(command, handle, signal)` directly so `spawnCaptureEffect` receives the signal.

*Verifier:* Confirmed in real code. SandboxTransportService.execute is typed (command, handle, signal?) and execute.js:610 threads runtime.signal. But sandbox-entity.js:174 service wrapper is `execute: (command, handle) => withClient(handle, "execute", { command }, (client) => client.execute({ command, handle }))` which drops the signal. SandboxExecutePayloadSchema (lines 78-81) carries only command+handle, so the signal cannot cross the Entity RPC boundary either, and the handler at :135 calls executor.execute(payload.command, payload.handle) with two args. The executors in http-runner.js and socket-runner.js declare `execute: (command, handle, signal)` and forward signal into spawnSandboxCommand -> spawnCaptureEffect (process-runner.js:295), but always receive signal===undefined. transportCall (execute.js:131) calls Effect.runPromise without passing the signal, so there is no Effect-level interruption fallback. The documented fix at process-runner.js:291-294 is therefore dead for the transport execute path. Real leak, but bounded: only fires when options.config.command is set (line 609 guard) and the process is still reaped at the ~10-min timeout, so high is overstated; medium fits.

### 110. [MEDIUM · data-loss] `packages/sandbox/src/execute.js:262`

**Accepted sandbox patch files (patches/*.patch) are counted and gated but never applied**

totalPatchCount = `validated.patchFiles.length + diffBundlePatchCount(validated.manifest.diffBundle)` (execute.js:482/660), and that count drives diff-review gating: if >0 and not autoAccept, the run throws "Sandbox produced changes that require review approval". On accept, the only application path is applyAcceptedSandboxChanges, which returns immediately when `validated.manifest.diffBundle === undefined` (execute.js:264) and applies ONLY the diffBundle via options.applyDiffBundle. The `patches/*.patch` files collected by validateSandboxBundle (bundle.js:161-164) are never applied anywhere. Result: a sandbox that emits patch files but no diffBundle reports N patches, forces the user through review/approval, and on approval applies nothing — the sandbox's changes are silently dropped while the system reports success. The gating and the application are inconsistent about what 'a patch' means.

**Fix:** Either apply the collected patchFiles on accept (e.g. `git apply`/`jj` each patch under options.rootDir), or stop counting patchFiles toward totalPatchCount/review-gating so the gate only fires for changes that will actually be applied. Make the count and the apply path use the same source of truth.

*Verifier:* Confirmed (same root defect as index 3, stated more generally). patchFiles from validateSandboxBundle (bundle.js:161-164) feed totalPatchCount (execute.js:482/660) which drives review gating and the 'requires review approval' throw (lines 517/695). On accept the only application path is applyAcceptedSandboxChanges, which short-circuits when manifest.diffBundle===undefined (line 264) and applies solely the diffBundle via options.applyDiffBundle. The patches/*.patch files are never applied anywhere in the codebase. Gating and application disagree on what counts as a patch: a bundle with patch files but no diffBundle reports N patches, forces approval, then applies nothing while reporting success.

### 111. [MEDIUM · data-loss] `packages/sandbox/src/execute.js:277`

**Provider results carrying only patch files (no diffBundle) are accepted but never applied**

`totalPatchCount` counts both standalone patch files and diffBundle patches: `validated.patchFiles.length + diffBundlePatchCount(validated.manifest.diffBundle)` (lines 482, 660). The review/accept logic gates on `totalPatchCount`, so a provider result that ships `.patch` files in patches/ (a supported writeSandboxBundle shape: `patches: Array<{path,content}>`) with NO `diffBundle` will: emit SandboxDiffReviewRequested/SandboxDiffAccepted (when autoAcceptDiffs) and then call `applyAcceptedSandboxChanges`. But that applier only handles the diffBundle:

  const diffBundle = validated.manifest.diffBundle;
  if (diffBundle === undefined) { return; }  // line 264-265
  ...
  await options.applyDiffBundle(diffBundle, options.rootDir);

So when there is no diffBundle it returns early and applies nothing, even though it just emitted SandboxDiffAccepted for patchFiles. The sandbox's changes are silently dropped while the run reports them as accepted/applied.

**Fix:** Either apply the standalone patchFiles in applyAcceptedSandboxChanges, or, if diffBundle is the only supported apply mechanism, reject/error when patchFiles>0 with no diffBundle rather than emitting SandboxDiffAccepted and applying nothing.

*Verifier:* Confirmed. totalPatchCount = validated.patchFiles.length + diffBundlePatchCount(...) (lines 482/660). patchFiles is a filesystem scan of patches/*.patch (bundle.js:161-164), and a provider can ship standalone patch files via source.patches with no diffBundle (materializeProviderResult line 223 -> writeSandboxBundle writes patches/*). When totalPatchCount>0 the code emits SandboxDiffReviewRequested/SandboxDiffAccepted and calls applyAcceptedSandboxChanges, which returns early at line 264 when diffBundle===undefined and only ever calls options.applyDiffBundle (line 277). grep confirms applyDiffBundle (engine/effect/diff-bundle.js:378) is the ONLY apply mechanism; nothing applies patchFiles. So patch-file-only results are gated/accepted but silently dropped.

### 112. [MEDIUM · concurrency] `packages/sandbox/src/execute.js:382`

**Sandbox concurrency limit check is a TOCTOU race under <Parallel>**

executeSandbox reads `existingSandboxes = await adapter.listSandboxes(runtime.runId)`, counts active rows, throws if `activeSandboxCount >= maxConcurrent`, and only AFTER that calls `adapter.upsertSandbox({... status: 'pending'})` (lines 382-404). When multiple `<Sandbox>` nodes run concurrently in a `<Parallel>` group within the same run, they all execute this read-check-write sequence interleaved: each can observe activeSandboxCount below the limit before any of them has written its 'pending' row, so all of them pass and the SMITHERS_MAX_CONCURRENT_SANDBOXES guard is bypassed. The limit exists specifically to bound resource usage (containers/processes), so the race defeats its purpose and can spawn far more concurrent sandboxes than configured.

**Fix:** Make the reserve-a-slot operation atomic: insert the 'pending' row first and enforce the cap in a single transactional/conditional DB write (e.g. INSERT then count-and-rollback, or a SQL upsert guarded by a count check inside one transaction), rather than read-then-write in JS.

*Verifier:* Real TOCTOU. executeSandbox does await adapter.listSandboxes (line 382), counts active rows, throws if >= maxConcurrent (385-391), and only afterward awaits adapter.upsertSandbox status 'pending' (392). The read-check-write is not atomic and the await points yield the event loop. Under <Parallel> multiple <Sandbox> compute nodes in the same run execute this sequence concurrently in the same process; each can observe the count below the limit before any writes its pending row, so all pass and the per-run cap is exceeded. The limit is meant to bound container/process resources, so the race defeats its purpose. Severity medium since it only loosens a soft cap rather than corrupting data.

### 113. [MEDIUM · logic] `packages/scheduler/src/makeWorkflowSession.js:98`

**findWaitingReason ignores waitAsync, suspending the run (and starving a ready Ralph) on a non-blocking approval/event**

`decide()`'s scheduling loop correctly honors `waitAsync` by setting `waiting-approval`/`waiting-event` and `continue`-ing without setting `waitReason` (lines 656-676). But at quiescence, `findWaitingReason` (lines 98-106) treats ANY task in `waiting-approval` or `waiting-event` as a hard blocking wait, with no `waitAsync` check. Because `decide()` consults `findWaitingReason` at line 719 BEFORE the ready-Ralph advancement block at line 723, an outstanding `waitAsync` approval/event will return `{_tag:'Approval'|'Event'}` and suspend the whole run even when a Ralph loop whose own subtree is fully terminal is sitting in `schedule.readyRalphs` ready to advance to its next iteration. `waitAsync` exists precisely so such a gate does not block the rest of the graph (it is even treated as terminal for traversal in scheduleTasks.js `isTraversalTerminal`), so an independent Ralph that should iterate is instead starved until the async gate resolves. Failure scenario: a `<Ralph>` loop running concurrently with a sibling `<Task waitAsync needsApproval>` stalls its iterations the moment all currently-runnable work drains, contradicting the documented non-blocking semantics of waitAsync.

**Fix:** Skip `waitAsync` descriptors when computing the primary wait reason in `findWaitingReason` (mirror the `waitAsync` carve-out used in the decide loop and in scheduleTasks `isTraversalTerminal`), and/or evaluate `schedule.readyRalphs` advancement before falling back to `findWaitingReason` so a ready Ralph can advance while only async gates remain outstanding.

*Verifier:* Confirmed real ordering bug. The decide() scheduling loop correctly makes a waitAsync gate non-blocking: a waitAsync needsApproval (656-664) or __waitForEvent (665-676) task is set to waiting-approval/waiting-event and `continue`s WITHOUT setting waitReason. scheduleTasks encodes the same intent: isTraversalTerminal (scheduleTasks.js:28-33) treats a waitAsync waiting-approval/waiting-event as terminal so the rest of the graph (including a sibling Ralph's readiness) proceeds. But at quiescence decide() calls findWaitingReason (line 719) BEFORE the readyRalphs advancement block (line 723), and findWaitingReason (98-106) returns {_tag:'Approval'|'Event'} for ANY task in waiting-approval/waiting-event with no waitAsync check. So when the only outstanding work is a waitAsync gate plus a ready Ralph (its subtree fully terminal, populated into schedule.readyRalphs), decide() returns Wait at 720-721 and never reaches the Ralph advancement at 723, suspending the whole run and starving the Ralph's next iteration. This contradicts waitAsync's documented non-blocking semantics and the #267 comment at 723-731. Reachable whenever a <Ralph> runs concurrently with a sibling waitAsync gate. Fix: skip waitAsync descriptors in findWaitingReason (or check readyRalphs before it).

### 114. [MEDIUM · crash] `packages/scheduler/src/retryPolicyToSchedule.js:18`

**switch on backoff has no default; returns undefined for unrecognized backoff values, crashing the retry path**

The `switch (backoff)` only handles "fixed", "linear", "exponential" and has no `default` branch, so any other string falls through and the function returns `undefined` (despite the `@returns {Schedule.Schedule}` contract). `backoff` is taken straight from the user-authored `retryPolicy` prop: `resolveRetryConfig` in packages/graph/src/extract.js (line ~139-143) does `hasExplicitRetryPolicy ? (raw.retryPolicy) : ...` with NO validation of the `backoff` value, and the `?? "fixed"` on line 16 only covers null/undefined, not an invalid string like `"constant"`. The engine then calls `retryScheduleDelayMs(retrySchedule, ...)` (packages/engine/src/engine.js:2517-2518), and retryScheduleDelayMs.js line 9 immediately dereferences `schedule.initial` — throwing `TypeError: Cannot read properties of undefined (reading 'initial')` inside the scheduling decision and aborting the run. A typo'd backoff in JSX (`retryPolicy={{ backoff: "const", initialDelayMs: 1000 }}`) crashes scheduling rather than degrading gracefully.

**Fix:** Add a `default:` arm to the switch that returns `capDelay(Schedule.fixed(Duration.millis(base)))` (or validate/normalize `backoff` to one of the three known values before the switch).

*Verifier:* Confirmed by execution. The switch on backoff (lines 18-25) handles only fixed/linear/exponential with no default, so an out-of-contract string returns undefined despite @returns {Schedule.Schedule}. retryScheduleDelayMs.js `let state = schedule.initial` then throws TypeError: undefined is not an object. Verified live: retryPolicyToSchedule({backoff:'const',initialDelayMs:1000}) returns undefined and the downstream call throws TypeError. Reachable: resolveRetryConfig (graph/extract.js) passes user raw.retryPolicy through unvalidated, and engine.js:2517-2518 invokes both functions when a node has an explicit retryPolicy and a failed attempt. A typo'd backoff crashes the scheduling decision.

### 115. [MEDIUM · concurrency] `packages/server/src/gateway.js:2789`  _(corroborated ×2)_

**processDueCrons has no re-entrancy guard, allowing overlapping ticks to double-fire a cron**

The scheduler fires both sweeps without awaiting them: `this.schedulerTimer = setInterval(() => { void this.processDueCrons(); void this.processDueTimers(); }, intervalMs)` (lines 2651-2654). `processDueTimers` protects itself against overlap with a flag (`if (this.timerSweepInFlight) return;` at 2884-2887, comment even says it 'Mirrors processDueCrons'), but `processDueCrons` (line 2789) has NO such guard. Inside it, a due cron is found, `await this.startRun(...)` is called, and only afterwards is `await adapter.updateCronRunTime(cron.cronId, now, nextCronRunAtMs(...))` written (lines 2811-2816). Because each setInterval callback returns immediately (the work is a detached promise), a second tick can begin while a prior sweep is still inside the read-fire-write window: it re-runs `adapter.listCrons(true)`, sees the same `nextRunAtMs <= now` (the update has not committed yet), and fires `startRun` again. The result is a duplicate workflow run for a single cron occurrence, i.e. duplicated side effects. The window widens with a slow shared DB (PGlite/Postgres under contention) or many registered workflows where one full sweep exceeds the >=1s interval.

**Fix:** Add the same in-flight guard used by processDueTimers, e.g. `if (this.cronSweepInFlight) return; this.cronSweepInFlight = true; try { ... } finally { this.cronSweepInFlight = false; }`. Optionally update the cron's nextRunAtMs (advance it) before starting the run so a concurrent reader sees it as not-due.

*Verifier:* processDueCrons (2789) has no in-flight guard, unlike processDueTimers which guards with timerSweepInFlight (2884-2887). Both are fired fire-and-forget from the same setInterval (2651-2654, interval >=1s). Inside processDueCrons the order is listCrons (2796) -> startRun (2811) -> updateCronRunTime (2816); the schedule advance commits only after startRun. Under a slow shared DB a second tick can read the same stale nextRunAtMs<=now and double-fire startRun for one cron occurrence. The asymmetry with processDueTimers confirms the missing guard.

### 116. [MEDIUM · logic] `packages/server/src/gateway.js:2841`

**Failed cron reuses past nextRunAtMs, causing immediate every-tick retry with no backoff**

In the cron failure path, `await adapter.updateCronRunTime(cron.cronId, now, cron.nextRunAtMs ?? now + 60_000, error?.message ?? "cron trigger failed")` reuses `cron.nextRunAtMs` as the new next-run time. But execution reached this point precisely because the cron was due, i.e. `cron.nextRunAtMs <= now` (see the skip check at line 2802), so `cron.nextRunAtMs` is a timestamp in the PAST. The `?? now + 60_000` fallback only applies when `nextRunAtMs` is null, which is not the common case. As a result, when a cron trigger fails (e.g. `startRun` throws synchronously for a broken/unknown workflow), the next scheduler tick (every 1-15s) sees it as due again and re-triggers immediately, hammering the failing workflow forever with no backoff and ignoring the configured schedule, while flooding error logs and `gatewayErrorsTotal` metrics. The success path correctly advances via `nextCronRunAtMs(cron.pattern)` (line 2816).

**Fix:** On failure, advance to a future time, e.g. `now + 60_000` unconditionally, or `Math.max(now + 60_000, nextCronRunAtMs(cron.pattern))`, so failed crons back off instead of retrying every tick.

*Verifier:* Cron failure path line 2841 reuses cron.nextRunAtMs as the new next-run time. Execution only reaches a fire because the skip check at 2802 passed (nextRunAtMs<=now), so cron.nextRunAtMs is in the past; the `?? now+60_000` only applies when it is null. The next scheduler tick (1-15s) sees the cron due again and re-fires immediately with no backoff, hammering a failing workflow and flooding logs/gatewayErrorsTotal. The success path correctly advances via nextCronRunAtMs (2816), confirming the asymmetry.

### 117. [MEDIUM · correctness] `packages/server/src/gateway.js:2988`

**Starting a run silently narrows an unrestricted connection to only that run**

On run start, `if (auth.subscribeConnection) { if (!auth.subscribeConnection.subscribedRuns) { auth.subscribeConnection.subscribedRuns = new Set(); } auth.subscribeConnection.subscribedRuns.add(runId); }`. For a connection that connected WITHOUT a subscribe filter, `subscribedRuns` is `null`, meaning "unrestricted, receives all run events" (the documented two-state contract at line 1763-1769). This code converts that `null` into a singleton `Set([runId])`. After that, `shouldDeliverEvent` (line 1298) returns true only for `runId`, so the connection STOPS receiving events for every other run it was previously seeing. A dashboard/monitor that opens an unrestricted WS connection and then launches a run through it silently loses visibility into all other runs. The auto-subscribe intent (extend an existing filter) is only correct when a filter already exists; it must not turn an unrestricted connection into a restricted one.

**Fix:** Only extend an existing (non-null) filter: `if (auth.subscribeConnection?.subscribedRuns) { auth.subscribeConnection.subscribedRuns.add(runId); }` — leave a null (unrestricted) subscription untouched so it keeps receiving all runs.

*Verifier:* startRun lines 2987-2992: if auth.subscribeConnection.subscribedRuns is falsy (null = unrestricted per the 1763-1769 contract) it creates a new Set and adds only runId. runs.create passes subscribeConnection:connection unconditionally (line 4607). After conversion shouldDeliverEvent returns true only for runId, and isDevToolsRunAuthorized now denies all other runs. An unrestricted connection that launches a run is silently narrowed to that single run, losing visibility into all others. Genuine correctness/visibility regression.

### 118. [MEDIUM · security] `packages/server/src/gateway.js:3427`

**trusted-proxy auth defaults to wildcard scopes ["*"] when scopes header is absent (fail-open)**

In `authenticateRequest` trusted-proxy mode, `const scopes = scopesValue ? scopesValue.split(...) : [...(this.auth.defaultScopes ?? ["*"])]`. When the trusted proxy forwards a request WITHOUT the scopes header (`scopesValue` empty/undefined) and no `defaultScopes` is configured, the connection is granted `["*"]` — full access to every gateway method. This is a fail-open default and is inconsistent with jwt mode, which defaults to an EMPTY scope set on the same condition: `scopes: scopes.length > 0 ? scopes : [...(this.auth.defaultScopes ?? [])]` (line 3414). A misconfigured or partially-trusted proxy that omits `x-user-scopes` thus silently escalates the caller to operator-level wildcard scope instead of denying.

**Fix:** Default trusted-proxy missing scopes to an empty array (`this.auth.defaultScopes ?? []`) for parity with jwt mode, requiring explicit opt-in to wildcard.

*Verifier:* authenticateRequest trusted-proxy branch line 3429-3431: when the scopes header is absent it falls back to `[...(this.auth.defaultScopes ?? ["*"])]` (full wildcard). The jwt branch (3418) defaults to `[...(this.auth.defaultScopes ?? [])]` (empty). A trusted proxy that omits x-user-scopes with no defaultScopes configured silently grants operator-level wildcard scope. Confirmed fail-open default and inconsistency with jwt mode.

### 119. [MEDIUM · correctness] `packages/server/src/gateway.js:4678`

**frames.get returns NOT_FOUND for old frames in runs with many frames**

In the `frames.get` route:
```js
const frameRow = frameNo === undefined
    ? await resolved.adapter.getLastFrame(runId)
    : (await resolved.adapter.listFrames(runId, Math.max(frameNo + 1, 50))).find((entry) => entry.frameNo === frameNo);
```
`adapter.listFrames(runId, limit)` returns the NEWEST `limit` frames (`ORDER BY frame_no DESC LIMIT ?`, see packages/db/src/adapter.js:2593). The limit `Math.max(frameNo + 1, 50)` is only correct if frames were returned oldest-first (ascending). Because they come back newest-first, requesting frame `frameNo` only succeeds when the total frame count `T` satisfies `T <= frameNo + max(frameNo+1,50) - 1` (roughly `T <= 2*frameNo`). For a long run, e.g. `frameNo=10` with `T=200`, listFrames returns frames 151..200, frame 10 is absent, and the handler returns `NOT_FOUND` ('Frame not found') even though the frame exists. This breaks time-travel/devtools lookups of early frames in any run with more than ~2x as many frames as the requested index.

**Fix:** Add a dedicated adapter method `getFrame(runId, frameNo)` (a single indexed `WHERE run_id = ? AND frame_no = ?` query) and call it here, instead of fetching a windowed list and scanning. If keeping listFrames, fetch with an afterFrameNo of `frameNo - 1` and limit 1, or fetch enough frames to cover the full history (not `frameNo+1`).

*Verifier:* frames.get line 4689 uses `listFrames(runId, Math.max(frameNo+1,50)).find(entry=>entry.frameNo===frameNo)`. adapter.listFrames (db/adapter.js:2593) is `ORDER BY frame_no DESC LIMIT ?` (newest-first), so the limit only includes early frame `frameNo` when the total count is roughly <= 2*frameNo. For a long run (e.g. frameNo=10, T=200) listFrames returns frames 151-200 and the handler returns NOT_FOUND though the frame exists. Confirmed correctness bug for early-frame lookups in long runs.

### 120. [MEDIUM · api-misuse] `packages/server/src/gateway.js:5233`

**Approval allowedScopes check routes scope names through requiredScopeForMethod, downgrading several scopes to run:read**

submitApproval enforces `request.allowedScopes` via `request.allowedScopes.some((scope) => hasScope(connection.scopes, scope))`. `hasScope(scopes, method, registry)` treats its 2nd argument as an RPC METHOD and computes `requiredScopeForMethod(method)`. For scope strings that are not in the small explicit list (run:read/write/admin, approval:submit, signal:submit, cron:read/write, observability:read) — e.g. `account:read`, `memory:read`, `prompt:read`, `score:read`, `ticket:read`, `ticket:write` — `requiredScopeForMethod` finds no matching method definition and falls back to `?? "run:read"`. So an approval gated on `allowedScopes: ["ticket:write"]` (or any of those scopes) is satisfied by ANY connection holding `run:read`, instead of requiring the named scope. The check should be a direct scope-membership test, not a method->scope mapping.

**Fix:** Check scope membership directly, e.g. `request.allowedScopes.some((scope) => hasGatewayScope(connection.scopes.map(normalizeGrantedScope), scope, scope))`, so the connection must actually hold (or imply) the named scope.

*Verifier:* submitApproval allowedScopes check (5243-5245) calls hasScope(connection.scopes, scope) where the 2nd arg is treated as an RPC method. For a scope string outside the explicit set (run:read/write/admin, approval:submit, signal:submit, cron:read/write, observability:read), requiredScopeForMethod (904-925) falls through to getRequiredScopeForGatewayMethod(scope) ?? 'run:read'. hasGatewayScope (scopes.ts:119) then returns true if the connection holds run:read (gatewayScopeImplies('run:read','run:read')). So an approval gated on e.g. allowedScopes:['ticket:write'] is satisfied by any run:read connection. Confirmed downgrade; should be a direct scope-membership test.

### 121. [MEDIUM · correctness] `packages/server/src/gateway.js:5383`

**Manual cron.trigger advances cron run-time before validating input/starting run, and never records failure**

In the `cron.trigger`/`cronRun` handler the cron run-time is advanced up front:

```js
if (resolvedCron) {
    await resolvedCron.adapter.updateCronRunTime(resolvedCron.cron.cronId, nowMs(), nextCronRunAtMs(resolvedCron.cron.pattern), null);
}
let input;
try { input = validateGatewayRpcInput(params.input); } catch (error) { ... return responseError(...); }
return responseOk(frame.id, await this.startRun(targetWorkflowKey, input, ...));
```

The call sets `lastRunAtMs = now`, advances `nextRunAtMs`, and writes `errorJson = null` BEFORE `validateGatewayRpcInput(params.input)` runs and BEFORE `startRun` is awaited. If input validation throws (returns an error response) or `startRun` rejects (propagates to executeRpc as an error), the cron has already been durably marked as having run successfully: the next *scheduled* execution is pushed forward (and may be skipped, since the scheduler at line 2802 skips when `nextRunAtMs > now`), and the failure is silently lost. Contrast the scheduled path (lines 2810-2842) which calls `updateCronRunTime(..., null)` only AFTER `startRun` succeeds (line 2816) and records the error via `updateCronRunTime(..., error?.message)` on failure (line 2841). The manual path does neither, so a failed manual trigger corrupts the cron schedule state and drops the error.

**Fix:** Mirror the scheduled path: validate input and call startRun first, then call updateCronRunTime with null errorJson only on success; on failure call updateCronRunTime with the error message (or do not advance run-time at all). Move the `updateCronRunTime` call after a successful `startRun`.

*Verifier:* cron.trigger handler (5384-5412): line 5393-5395 calls updateCronRunTime(... nextCronRunAtMs, null) BEFORE validateGatewayRpcInput (5397-5405) and before startRun (5406). If input validation fails (returns error) or startRun rejects, the cron is already durably marked as run (lastRunAtMs=now, nextRunAtMs advanced, errorJson=null), and since the scheduler skips when nextRunAtMs>now (2802) the next scheduled run can be skipped while the failure is lost. Contrast the scheduled path which advances only after startRun succeeds (2816) and records error on failure (2841). Confirmed schedule-corruption + dropped error.

### 122. [MEDIUM · resource-leak] `packages/server/src/gateway.js:5738`

**Stream subscribe not tracked for abort; disconnect during subscribe() leaks handler resources**

In `subscribeExtensionStream`, the local `abort` controller (created at line 5630) and `cleanupFn` are only registered into `this.extensionStreamSubscriptions` AFTER `await resolved.entry.subscribe(params, streamCtx)` resolves (lines 5767-5776). The stream path is also NOT registered via `trackExtensionPendingHandler` — `routeExtensionRequest` returns early for `resolved.kind === "stream"` (line 5518-5519) before reaching `this.trackExtensionPendingHandler(connection, abort)` (line 5526). So while the extension's `subscribe()` is in flight, the abort controller is referenced nowhere reachable by the cleanup path. If the connection drops during the await, `cleanup()` -> `void this.cleanupExtensionSubscriptions(connection)` (line 3176) finds no map entry and no pending handler, so `abort.abort()` never fires and the eventual `cleanupFn` is never invoked. The subscribe handler keeps running with a signal that never aborts, and when it finally resolves it registers a live subscription (with cleanup) against an already-dead connection that nothing will ever tear down — a durable leak of db cursors / ElectricSQL shape handles / timers the handler allocated. This directly contradicts the stated design ('a disconnect releases handler-owned resources even if the handler never observed the abort signal').

**Fix:** Track the stream's `abort` (and a placeholder cleanup) immediately after creating the AbortController, before awaiting `subscribe()` — e.g. register into `extensionStreamSubscriptions` (or the pending-handlers set) up front and update the cleanup once the result is known, removing it on error. That way a disconnect during subscribe fires the abort and runs whatever cleanup has been established.

*Verifier:* subscribeExtensionStream registers {abort,cleanup} into extensionStreamSubscriptions only AFTER `await resolved.entry.subscribe(...)` resolves (5778-5787), and routeExtensionRequest returns at 5529-5531 for stream kind BEFORE trackExtensionPendingHandler (5537). So during the subscribe() await the abort is in neither map. cleanupExtensionSubscriptions (5812-5835, called once on disconnect via the cleanedUp-guarded path 3167-3180) cannot reach it. If the connection drops mid-subscribe, abort never fires and the eventual resolution registers a live subscription against a dead connection with no future teardown. For idle/low-traffic subscriptions the backpressure tear-down never triggers, so db cursors/Electric shape handles leak. Directly violates the stated design at 5805-5808.

### 123. [MEDIUM · error-handling] `packages/server/src/gatewayRoutes/getNodeDiff.js:16`

**Histogram metrics created without boundaries; every Metric.update throws and is silently swallowed**

Lines 16-17 construct two histogram metrics with only a name and no boundaries:

```
const nodeDiffComputeMs = Metric.histogram("smithers_node_diff_compute_ms");
const nodeDiffBytes = Metric.histogram("smithers_node_diff_bytes");
```

Effect's signature is `Metric.histogram(name, boundaries, description?)` and `boundaries` is REQUIRED. Construction succeeds, but every later `Metric.update(nodeDiffComputeMs, ...)` (lines 400, 447) and `Metric.update(nodeDiffBytes, ...)` (line 382) throws at runtime. I reproduced this with the repo's installed effect: `Metric.update` throws `undefined is not an object (evaluating 'key.keyType.boundaries.values')`. Because all these updates are wrapped in `swallow(...)` / `emitEffect(...)` whose errors are intentionally discarded, the failure is invisible: the `smithers_node_diff_compute_ms` and `smithers_node_diff_bytes` histograms NEVER record a single sample. The whole point of this route (per the in-file comments about Blocker #5/#6 compute-time and byte histograms) is to emit these metrics, so observability for diff compute latency and payload size is permanently dead.

**Fix:** Pass boundaries when constructing the histograms, e.g. `Metric.histogram("smithers_node_diff_compute_ms", MetricBoundaries.exponential({ start: 1, factor: 2, count: 16 }))` and a byte-scaled boundary set for nodeDiffBytes (import `MetricBoundaries` from effect). Optionally use `Metric.timer` for the ms metric.

*Verifier:* effect 3.21.1 Metric.d.ts:400 declares histogram(name, boundaries: MetricBoundaries, description?) — boundaries is a required positional arg. Lines 16-17 call Metric.histogram with only a name. Reproduced at runtime against the installed effect: Effect.runSync(Metric.update(h,5)) throws 'undefined is not an object (evaluating key.keyType.boundaries.values)'. All updates (lines 381 nodeDiffBytes, 400 & 447 nodeDiffComputeMs) are inside swallow()/emitEffect that discard errors, so failures are invisible and the two histograms never record a sample. Counters and gauges are unaffected; the route itself still returns. Real silent observability defect, no crash, so medium.

### 124. [MEDIUM · security] `packages/server/src/gatewayUi/auth.js:11`

**Custom gateway/workflow UIs bypass gateway auth (only the builtin operator console is gated)**

`authorizeGatewayUiRequest` only enforces authentication when the matched UI is the builtin operator console:

```js
const isBuiltinOperator = options.match.config.config.builtin === "operator";
if (!isBuiltinOperator || options.authMode === "none") {
    return null;
}
```

In `gateway.js`, `resolveGatewayUiConfig` only sets `builtin: "operator"` for the default/`ui:true` console; a custom gateway-level UI (`new Gateway({ ui: { entry, path, props } })`) and every workflow-level UI (`entry.ui`) resolve with `builtin` undefined, so `isBuiltinOperator` is false and the function returns `null` (authorized) unconditionally. `handleUiHttp` calls this for both the HTML index and the bundled `client.js` asset. Result: with the gateway configured for `token`/`jwt` auth, an anonymous client can still GET a custom UI's HTML shell and its bundled JS. The shell embeds `props` via `globalThis.__SMITHERS_GATEWAY_UI__=...` (`renderUiIndex` -> `uiBootConfig`), so any boot data a developer placed in `props` (assuming the gateway is protected) leaks to unauthenticated clients, and the existence/structure of mounted UIs is exposed. This is inconsistent with the operator console, which the test suite explicitly verifies requires bearer auth (gateway-ui.test.jsx). The RPC/WS layer is still gated, but the UI surface is not.

**Fix:** Gate all UI mounts when gateway auth is configured, not just the builtin operator. Either drop the `isBuiltinOperator` short-circuit (authenticate whenever `authMode !== "none"`), or make the per-UI auth requirement explicit in the resolved config and check that flag instead of hard-coding `builtin === "operator"`.

*Verifier:* Confirmed in real code. gatewayUi/auth.js:10-13: authorizeGatewayUiRequest returns null (authorized) whenever match.config.config.builtin !== "operator". In gateway.js, resolveGatewayUiConfig (line 219) only sets builtin:"operator" for ui===true; a custom gateway UI ({entry,path,props}) and every workflow UI (resolved via the same function at line 2423) get builtin undefined. getUiMounts (1421) maps these to kind "gateway"/"workflow" with builtin-undefined configs. handleUiHttp (1532-1556) is the SOLE auth checkpoint for UI HTTP requests (called at line 2490; RPC/webhook handlers above do their own internal auth, no global middleware), and it passes match:uiMatch so match.config.config.builtin is "operator" only for the builtin console. Thus with auth configured (token/jwt, authMode != none), isBuiltinOperator is false -> returns null -> custom/workflow UIs serve anonymously. renderUiIndex (1490) embeds uiBootConfig props via globalThis.__SMITHERS_GATEWAY_UI__, and renderUiAsset serves client.js, both reachable unauthenticated. gateway-ui.test.jsx:175-206 verifies the operator console returns 401 anonymously, establishing intended gating that custom/workflow UIs lack. Real inconsistency + props/bundle exposure. Note: runtime data still flows through gated RPC/WS, so impact is bounded to the HTML shell, developer props, and JS bundle -> medium, not high.

### 125. [MEDIUM · correctness] `packages/server/src/gatewayUi/defaultOperatorUi.js:893`  _(corroborated ×2)_

**Full innerHTML re-render on every stream event destroys form input focus/caret**

render() (line 1256) rebuilds the entire UI with `root.innerHTML = ...` and then re-runs bind(). render() is invoked unconditionally from handleDevToolsEvent (line 893) and handleRunStreamFrame on every `run.heartbeat`/`run.event` (lines 964, 977) plus the 5s setInterval(refresh) (line 1429). When a run is selected and streaming, render() fires many times per second. Each call recreates the `#run-input` textarea, `#token` input, and `#workflow` select DOM nodes, so the focused element is destroyed and focus jumps to <body>, the caret/selection is lost, and any in-progress IME composition is dropped. The Input JSON textarea in the launch form becomes effectively untypeable while watching a live run. The values themselves survive (state is updated on each input event before render), so this is focus/caret loss rather than data loss.

**Fix:** Avoid wholesale innerHTML replacement for the parts of the page that contain editable inputs (render the launch form / token field once and update only the streaming panes), or preserve and restore document.activeElement + selectionStart/selectionEnd around the innerHTML swap, or skip re-rendering the form region when one of its inputs is focused.

*Verifier:* Duplicate of finding 0 from the handler angle. render() (1256) rebuilds the whole UI with innerHTML and re-runs bind(); it is invoked from handleDevToolsEvent (893) and handleRunStreamFrame (964,977,...) on every frame plus setInterval(refresh) (1429). Each call destroys #run-input, #token, #workflow nodes so the focused element loses focus/caret/IME composition during a live run. Values survive (state updated on input) but focus does not. Real focus/caret-loss defect.

### 126. [MEDIUM · correctness] `packages/server/src/gatewayUi/defaultOperatorUi.js:1258`

**Full DOM re-render on every stream event and 5s poll steals input focus, selection, and scroll**

render() does `root.innerHTML = "..."` (line 1258) which destroys and recreates the entire DOM, including the `#token` input and the `#run-input` textarea, on EVERY call. render() is called: from the 5-second `setInterval(refresh, 5000)` (line 1429); from every DevTools event via handleDevToolsEvent->render() (line 893); and from every run event/heartbeat via handleRunStreamFrame->render() (lines 964,977,989,1001). Consequences: (1) While a user types the Bearer token (required to authenticate) or edits the Input JSON, focus and caret are lost every 5s even when idle. (2) For a selected, active run the chronicle/devtools sockets fire render() on each incoming frame (potentially many per second), so the token field, the JSON textarea, and the scroll position of the runs/chronicle/tree panes are blown away continuously, making the console effectively unusable during a live run. The handlers do update state on input so text content survives, but focus/caret/scroll do not.

**Fix:** Do not rebuild innerHTML wholesale on every event. Either (a) skip re-render of the input controls (preserve and restore focus/caret/scroll across render, e.g. record document.activeElement.id + selectionStart and restore after innerHTML assignment), or (b) move to targeted DOM updates / batch renders with requestAnimationFrame and avoid re-rendering panes that contain focused inputs.

*Verifier:* render() at line 1258 does `root.innerHTML = ...` then bind(), recreating the #token input and #run-input textarea on every call. render() is called unconditionally from setInterval(refresh,5000)->refresh->render (1384), from handleDevToolsEvent (893), and from handleRunStreamFrame on every run.heartbeat/run.event/gap_resync/run.error (964,977,989,1001). Setting innerHTML destroys the focused element, so caret/focus/scroll are lost every 5s even idle, and continuously during a live run. Input handlers update state on each keystroke so values survive but focus/caret do not. Genuine UX defect.

### 127. [MEDIUM · resource-leak] `packages/server/src/index.js:302`

**Prometheus route label cardinality explosion for /cancel and /resume routes**

`normalizeHttpMetricRoute` (lines 276-305) collapses runId-bearing paths to templated routes for events/frames/approve/deny/signals/:runId, but has NO case for `/v1/runs/:runId/cancel` or `/v1/runs/:runId/resume`. The final `/^\/v1\/runs\/[^/]+$/` test does not match those (extra trailing segment), so the function returns the raw pathname containing the actual runId. `recordHttpRequestMetrics` then uses that as the `route` tag (line 323), creating a brand-new Prometheus time series per distinct runId on every cancel/resume call. Over time this is unbounded label cardinality that grows the metrics registry memory without limit (a slow DoS / OOM on the metrics path).

**Fix:** Add regex cases that map `/^\/v1\/runs\/[^/]+\/cancel$/` -> `/v1/runs/:runId/cancel` and `/^\/v1\/runs\/[^/]+\/resume$/` -> `/v1/runs/:runId/resume` before the fall-through return.

*Verifier:* Confirmed. normalizeHttpMetricRoute (276-305) templates events/frames/approve/deny/signals/:runId and the trailing `/^\/v1\/runs\/[^/]+$/`, but has no case for `/v1/runs/:id/cancel` or `/v1/runs/:id/resume`; that final regex does not match (extra segment), so it returns the raw pathname with the real runId. requestPathname=url.pathname (672) is passed to recordHttpRequestMetricsSafely in the finally (1212), which tags httpRequests/httpRequestDuration with route=raw path (323). Each distinct runId hit on cancel/resume creates a new time series = unbounded label cardinality. Real leak.

### 128. [MEDIUM · resource-leak] `packages/server/src/serve.js:58`

**Unknown/404 request paths become raw Prometheus label values, unbounded metric cardinality (memory DoS)**

`normalizeHttpMetricRoute` only collapses a fixed whitelist of routes and the two `:nodeId` patterns; for anything else it returns the raw pathname verbatim:
```js
return pathname;
```
The timing middleware (`app.use("*")`, line 138) runs for unmatched routes too (Hono runs matching `*` middleware before invoking `notFound`), so every 404 is recorded via `recordHttpRequestMetrics` with `route: normalizeHttpMetricRoute(c.req.path)`. An attacker (or a buggy client) hitting `/aaa`, `/bbb`, `/ccc`, ... creates a new `{route=...}` time-series per distinct path. The in-process Prometheus registry retains every distinct label set forever, so unique-path traffic causes unbounded memory growth and metric-scrape bloat. When `authToken` is unset (the common localhost case) this is fully unauthenticated. Fix: map any non-whitelisted path to a constant like `"<other>"` instead of returning `pathname`.

**Fix:** In normalizeHttpMetricRoute, replace the final `return pathname;` with `return "<other>";` (a bounded sentinel) so unknown/404 paths cannot explode label cardinality.

*Verifier:* normalizeHttpMetricRoute (lines 45-59) returns the raw pathname verbatim for any non-whitelisted path. When authToken is unset, no auth middleware is registered, so the timing middleware app.use("*") (line 138) executes for every request including 404s and calls recordHttpRequestMetrics with route: normalizeHttpMetricRoute(c.req.path). Each distinct route becomes a new Effect Metric tag set; renderPrometheusMetrics reads the process-global metric registry which retains every distinct label combination indefinitely. Distinct-path traffic (e.g. /aaa, /bbb...) grows cardinality unbounded -> memory/scrape bloat. Confirmed reachable and unbounded.

### 129. [MEDIUM · api-misuse] `packages/smithers/src/external/create-external-smithers.js:57`

**Array-of-agents (fallback chain) references are not resolved in hostNodeToReact**

`hostNodeToReact` only resolves the `agent` prop when it is a single string: `if (typeof rawProps.agent === "string") { ... rawProps.agent = resolved; }`. But the `Task` component explicitly supports `agent?: AgentLike | AgentLike[]` (TaskProps.ts:24-25 "Agent or array of agents [primary, fallback1, fallback2, ...]. Tries in order on retries."). When an external `buildFn` emits `agent: ["claude", "codex"]` in `rawProps`, `typeof rawProps.agent` is `"object"`, so the branch is skipped and the raw string array is passed straight through to `BaseTask`. In Task.js the array becomes `agentChain` (line 229-241) and each string is handed to the engine as if it were an `AgentLike`; the engine then invokes agent methods on a plain string and the run crashes with an obscure error (or silently misbehaves) instead of resolving the named agents or raising the clear UNKNOWN_AGENT error that single-agent references get. This silently breaks the documented agent-fallback feature for every external workflow.

**Fix:** Handle arrays: if `Array.isArray(rawProps.agent)`, map each entry, resolving string entries via the registry (throwing UNKNOWN_AGENT on misses) and leaving already-resolved AgentLike entries as-is, then assign the resolved array back to rawProps.agent.

*Verifier:* hostNodeToReact (create-external-smithers.js:57) only resolves agent when `typeof rawProps.agent === "string"`. TaskProps.ts:25 documents `agent?: AgentLike | AgentLike[]` (fallback chain). In the external JSON model agents are only referenced by string name (the sole purpose of the resolution branch), so an array fallback emits string names that skip the branch and pass through to BaseTask -> agentChain (Task.js:229) -> smithers:task `agent` prop. Engine (engine.js:3121 allAgents, 3155-3161 reads effectiveAgent.cliEngine/.hijackEngine) expects AgentLike objects and never resolves string names itself, so array refs break and also bypass the clear UNKNOWN_AGENT error single refs get. Reachable, genuine defect.

### 130. [MEDIUM · correctness] `packages/smithers/src/migrateSmithersStore.js:745`

**Reverse migration recreates Postgres indexes with a schema-qualified table name SQLite cannot parse**

In `prepareSqliteTarget` (reverse pg/pglite -> sqlite path), indexes for newly created tables are translated with an inline regex rather than the real translator used on the forward path:

```js
for (const index of await pgIndexes(pgConn, table)) {
    const indexSql = index.sql
        .replace(/\bCREATE\s+(UNIQUE\s+)?INDEX\s+/i, (_m, unique = "") => `CREATE ${unique}INDEX IF NOT EXISTS `)
        .replace(/\s+USING\s+btree\b/gi, "");
    sqlite.exec(indexSql);
}
```

`pgIndexes` returns `index.sql` from `pg_indexes.indexdef`, whose value comes from `pg_get_indexdef`, which always schema-qualifies the table, e.g. `CREATE INDEX foo ON public.mytable USING btree (col)`. The regex only rewrites the CREATE prefix and removes `USING btree`, leaving `ON public.mytable`. SQLite's CREATE INDEX grammar does NOT allow a schema-qualified table in the ON clause (the schema qualifier goes on the index name, not the table), so `sqlite.exec("CREATE INDEX IF NOT EXISTS foo ON public.mytable (col)")` throws a syntax error. It will also fail to translate Postgres operator classes / partial-index predicates that the forward path handles via `translatedCreateIndex`/`translateDdl`. This only affects tables created fresh in the reverse path (custom/workflow output tables and `input` — the canonical `_smithers_*` tables are created by `ensureSmithersTables` and skip this branch), so a reverse migration of any workspace whose custom tables carry a secondary or unique index aborts during `prepareSqliteTarget`, and the temp file is cleaned up, leaving the user unable to migrate back to sqlite.

**Fix:** Route the reverse index DDL through the existing SQLite translator instead of the ad-hoc regex (mirror `translatedCreateIndex` but targeting SQLITE), or at minimum strip the `<schema>.` qualifier from the ON clause (e.g. replace `ON "?schema"?\.` / `ON public.` with `ON `) and drop Postgres-only operator-class / `USING` clauses before `sqlite.exec`.

*Verifier:* Confirmed by execution. In prepareSqliteTarget the index branch (744-748) translates pgIndexes' index.sql with an inline regex that only rewrites the CREATE prefix and strips ' USING btree', not the schema qualifier. I verified in pglite that pg_indexes.indexdef = 'CREATE INDEX myidx ON public.mytable USING btree (col)' (schema-qualified table, from pg_get_indexdef). After the regex the result is 'CREATE INDEX IF NOT EXISTS myidx ON public.mytable (col)', and bun:sqlite rejects it: 'near ".": syntax error' (SQLite's CREATE INDEX grammar does not allow a schema-qualified ON table). This branch only runs for fresh tables (sqliteTableExists→continue at 723-734), i.e. custom/workflow output tables — canonical _smithers_* tables are created by ensureSmithersTables (1065). So a reverse migration aborts whenever a custom table carries a non-pkey index (pgIndexes excludes %_pkey, 684), and the temp file is cleaned up, leaving the user unable to migrate back. Conditional on custom tables having secondary/unique indexes, hence medium.

### 131. [MEDIUM · data-loss] `packages/smithers/src/migrateSmithersStore.js:1288`

**Forward migration to pglite/postgres is non-atomic and leaves partial data on failure, blocking retries**

The forward path (`migrateSmithersStore`, lines ~1207-1302) writes table-by-table directly into the live target store, committing each table's copy in its own pg transaction (`copyTable` does `BEGIN`/`COMMIT` per table). If any later table fails (a count mismatch at lines 1229-1237, a constraint, a transient error), the function rethrows but the `finally` block (lines 1288-1302) only closes the source `sqlite` handle and the `targetApi` — it does NOT remove the partially-populated target. This is asymmetric with the reverse path `migratePgToSqlite`, which deliberately builds in a temp file and cleans it up when `!published` (lines 1123-1132). Concrete failure: `migrate --to pglite` fails after copying tables 1-4. The marker is never written. On retry, `inferSourceBackend` (no receipt, no --from) runs the run-count heuristic and now sees BOTH sqlite (>0) AND the partial pglite (>0) populated, throwing `SMITHERS_BACKEND_CONFLICT` ("Multiple Smithers backend stores contain run history; pass --from explicitly"). Even passing `--from sqlite` then hits `prepareTargetTables` line 326 `DB_WRITE_FAILED` ("Target table _smithers_runs already has N rows"). The operator is stuck until they manually delete `.smithers/pg`. The repo's own tests work around this by `rmSync`-ing the pglite dir / markers between rounds.

**Fix:** Mirror the reverse path: build the pglite target in a temp data dir (or wrap the whole multi-table copy + verification in a single transaction) and only publish atomically after verification; on failure in the `finally`/`catch`, remove the partially-written target store so a retry starts clean.

*Verifier:* Confirmed. The forward path (migrateSmithersStore, 1207-1302) writes table-by-table via copyTable, which does its own BEGIN (line 370) / COMMIT (line 392) per table, committing each table's copy independently into the live target store (pglite/postgres). On a later failure (count-mismatch at 1230-1236, constraint, transient), the function rethrows and the finally block (1288-1302) only ROLLBACK/closes the read-only sqlite handle and calls targetApi.close() — it never removes the partially-populated target, unlike migratePgToSqlite which builds in a temp file and rmSyncs it when !published (1123-1132). The marker is only written on success (1254), so on retry inferSourceBackend has no receipt and runs the heuristic. Because tablePriority puts _smithers_runs 2nd (copied early), the partial pglite has runCount>0 AND sqlite>0 → SMITHERS_BACKEND_CONFLICT (974-978). Passing --from sqlite then hits prepareTargetTables 324-330 DB_WRITE_FAILED ('already has N rows'). The repo's 'no partial write' tests (394-457) only cover pre-write source-open failures (corrupt/unopenable source), NOT a mid-copy failure, so they do not refute this. Operator must manually delete .smithers/pg (or drop pg tables). Severity medium: no source data loss (keepSqlite defaults true, source removed only on success), but retries are hard-blocked.

### 132. [MEDIUM · data-loss] `packages/smithers/src/resolveSmithersBackendChoice.js:382`

**Migration marker suppresses the migration gate even when the resolved backend differs from the migration target, silently hiding run history**

`const marker = migratedMarker.exists && (migratedMarker.backend === "pglite" || migratedMarker.backend === "postgres")` (line 382) is a blanket suppression flag. It is later used at line 443 (`if ((backend === "pglite" || backend === "postgres") && sqliteStore.runCount > 0 && !marker)`) and line 398/409 to decide whether to fail loud. But `marker` never checks that the migration TARGET recorded in migrated.json (`migratedMarker.backend`) matches the actually-resolved `backend`. Concrete failure: a user migrates sqlite->pglite (migrated.json target=pglite, sqlite kept, pglite holds the 10 migrated runs), then later sets `SMITHERS_BACKEND=postgres` against a fresh empty Postgres. Trace: backend=postgres, marker=true (target pglite). migratedTargetBackend resolves to pglite and the block at 412-431 only verifies the *pglite* target has data (it does), never comparing to the resolved postgres backend. Line 443's gate is skipped because `!marker` is false, and line 453 divergence is skipped because `!marker` is false. We open the empty Postgres while both the sqlite (10 runs) and pglite (10 runs) stores hold all history, silently hiding every run. The whole purpose of this module is to fail loud rather than hide runs, and here it does not. Data is not destroyed but is invisible until the user reverts the override.

**Fix:** Only let the marker suppress the gate when the migration target equals the resolved backend, e.g. `const marker = migratedMarker.exists && (migratedMarker.backend === "pglite" || migratedMarker.backend === "postgres") && migratedMarker.backend === backend;` (and similarly gate migratedTargetBackend on matching the resolved backend), so an override to a different non-target backend still triggers SMITHERS_MIGRATION_REQUIRED / conflict detection.

*Verifier:* Line 382 marker keys off migratedMarker.backend (the recorded migration TARGET), never compared to the resolved backend. Trace cited scenario (migrated.json target=pglite; sqlite and pglite each hold 10 runs; then SMITHERS_BACKEND=postgres against empty postgres): backend=postgres, marker=true. populated=[sqlite,pglite] len 2 but line 398 conflict is gated by !marker so skipped. migratedTargetBackend=pglite; explicitSqliteOverride false so block 413 runs, but line 414 filter excludes both pglite (==target) and sqlite, leaving unexpectedPopulated empty so no conflict; line 418 only checks the pglite target has data (10>0), never that resolved postgres is empty. Line 444 gate !marker is false so skipped. Line 454 divergence guard is if(!marker) so skipped. Returns empty postgres while sqlite(10) and pglite(10) are silently hidden, contradicting the stated fail-loud purpose. Data hidden not destroyed and trigger needs a deliberate override to a third backend mismatching the migration target, so medium.

### 133. [MEDIUM · correctness] `packages/smithers/src/resolveSmithersBackendChoice.js:470`

**Legacy SQLite store detected by run-count probe but choice.dbPath still points at the (nonexistent) primary path, so reads of a legacy .smithers/smithers.db fail as NOT_FOUND**

`inspectLegacySqliteStore` (lines 84-99) scans both the primary `<root>/smithers.db` and the legacy `<root>/.smithers/smithers.db`, and returns the populated store (including its own `dbPath`, possibly the legacy path) so `choice.sqlite`/`choice.runCount` reflect the legacy store. However the returned `choice.dbPath` (line 470) is the separate `dbPath` variable computed at line 355 (`resolve(cwd, opts.dbPath ?? <root>/smithers.db)`), which is NOT updated to the populated legacy location. Consumers that open the sqlite store use `choice.dbPath`: in openSmithersStore.js `assertReadStoreExists` (line 61) and `sqliteHasRunsTable`/`openSqliteStore` (lines 189-192) all use `choice.dbPath`. So when run history exists only at `.smithers/smithers.db` and no root `smithers.db` exists, `resolveSmithersBackendChoice` reports `runCount > 0` while `smithers ps`/`inspect` throw CLI_DB_NOT_FOUND because `choice.dbPath` (root) does not exist. The detection and the open path disagree about where the data is.

**Fix:** When `inspectLegacySqliteStore` selects a populated fallback location, propagate that path into the returned `choice.dbPath` (or have the sqlite open path use `choice.sqlite.dbPath`), so reads target the same file the run-count probe found.

*Verifier:* inspectLegacySqliteStore (84-99) probes both <root>/smithers.db and legacy <root>/.smithers/smithers.db, returning the populated store whose own dbPath may be the legacy location, so sqliteStore.runCount and sqliteStore.dbPath reflect the legacy store. But choice.dbPath (line 471) is the dbPath const from line 355 (primary path), never updated to sqliteStore.dbPath. Confirmed in consumer openSmithersStore.js: assertReadStoreExists uses existsSync(choice.dbPath) (line 61), and lines 189/192/197 use sqliteHasRunsTable(choice.dbPath)/openSqliteStore(choice.dbPath)/dbPath:choice.dbPath, never choice.sqlite.dbPath. So when history exists only at .smithers/smithers.db and no root smithers.db exists, resolve reports runCount>0 yet smithers ps/inspect throw CLI_DB_NOT_FOUND on the nonexistent root path. Notably migrateSmithersStore.js inferSqliteSourceDbPath (856-866) DOES resolve to the legacy candidate, proving the open path is inconsistent with the migrate path. Detection and open disagree about where the data is.

### 134. [MEDIUM · security] `packages/smithers/src/tools/bash.js:19`

**Network isolation is only enforced on macOS via sandbox-exec; on Linux/Node it silently falls back to no isolation**

`resolveNetworkIsolatedCommand` only wraps the command with `sandbox-exec` when `process.platform === "darwin"` AND `Bun.which("sandbox-exec")` is found; otherwise it returns `{command: cmd, args}` unchanged. On Linux (the CI/server platform) or when running under Node (`globalThis.Bun` undefined), `allowNetwork:false` provides NO kernel-level network sandbox — the only protection is the `assertNetworkAllowed` token blocklist, which is trivially bypassable (e.g. `python -c 'import urllib...'`, `node -e`, `nc`, `ssh`, `perl`, `scp`). A caller relying on `allowNetwork:false` to actually prevent egress gets a false security guarantee on the primary deployment platform, and the macOS-missing-binary path fails open silently as well.

**Fix:** Fail closed when isolation cannot be enforced (throw if allowNetwork is false and no sandbox mechanism is available), or implement a real Linux network sandbox (e.g. unshare/namespaces); at minimum document and surface that the blocklist is best-effort only.

*Verifier:* Confirmed. resolveNetworkIsolatedCommand (bash.js:19-30) only wraps with sandbox-exec when process.platform==='darwin' AND Bun.which('sandbox-exec') is found; otherwise returns {command:cmd,args} unchanged. On Linux (CI/server) and under Node (no globalThis.Bun), there is no kernel-level network sandbox; the only remaining enforcement is the assertNetworkAllowed blocklist, which covers only curl/wget/npm/bun/pip, git remote ops, and tokens that literally startsWith http(s)://. That is trivially bypassable (python -c, node -e, nc, ssh, scp, perl, or a URL passed as urlopen("http://...") which is not a token-prefix match). The macOS-missing-binary path also falls open silently (test at line 464-472 even exercises this fallback running the command unwrapped). Docs explicitly state allowNetwork:false 'keeps bash offline' / 'Default: blocked' (docs/llms-observability.txt:101, llms-integrations.txt:1358), so on the primary deployment platform the documented guarantee is not actually enforced. Severity kept at medium since the blocklist provides partial best-effort coverage.

### 135. [MEDIUM · logic] `packages/smithers/src/tools/bash.js:130`

**Network blocklist false-positives block legitimate git/bash commands by matching words anywhere in args**

`assertNetworkAllowed` flattens `[cmd, ...args]` by splitting EVERY token on whitespace and then matches against blocklists, so harmless words inside commit messages, grep patterns, filenames, etc. trigger a hard error. The git check `if (executables.has("git")) { ... if (tokens.some(token => gitRemoteOps.has(token))) throw }` blocks `git commit -m "fix the pull request handling"` because the word `pull` is one of `{push,pull,fetch,clone,remote}` (verified: would block = true). Likewise the executable check `networkExecutables.some(name => executables.has(name))` blocks `echo "install with npm later"` because the token basename `npm` is in `[curl,wget,npm,bun,pip]` (verified: block = true). Any URL substring (`token.startsWith('http://')`) inside a message is also blocked. These are legitimate, non-network commands that are rejected with TOOL_GIT_REMOTE_DISABLED / TOOL_NETWORK_DISABLED, making the bash tool unusable for routine git work when allowNetwork is false (the default).

**Fix:** Only inspect the executable token (cmd basename) and not free-text message/pattern tokens; e.g. derive the program name from `cmd` alone, and for git only treat the first non-flag subcommand token as the operation rather than scanning every word in every arg.

*Verifier:* Confirmed. assertNetworkAllowed (bash.js:112-114) does `[cmd, ...args].flatMap(part => String(part).split(/\s+/))`, flattening EVERY arg including message strings into whole tokens. Since spawn is used without shell (utils.js:123), `git commit -m "fix the pull request handling"` arrives as cmd='git', args=['commit','-m','fix the pull request handling']; the message splits to tokens including the whole word 'pull', executables.has('git') is true (bash.js:130), and gitRemoteOps={push,pull,fetch,clone,remote} matches 'pull' → throws TOOL_GIT_REMOTE_DISABLED. Likewise echo "install with npm later" splits to a whole 'npm' token, basename in networkExecutables=[curl,wget,npm,bun,pip] → TOOL_NETWORK_DISABLED. allowNetwork defaults to false (utils.js:20). The existing test 'network guard matches whole tokens, not substrings' only covers substrings (bundle/pipeline), NOT whole blocked words embedded in argument/message text, so this false-positive is uncovered and real.

### 136. [MEDIUM · security] `packages/smithers/src/tools/grep.js:13`

**grep passes user pattern as a positional rg arg with no `--`/`-e`, allowing flag injection and breaking dash patterns**

`captureProcess("rg", ["-n", pattern, resolvedRoot], ...)` places the agent-controlled `pattern` as a bare positional. ripgrep parses any positional beginning with `-` as a flag, so (1) a legitimate search for a string starting with `-` (e.g. pattern `"-foo"`) fails with exit code 2 and throws TOOL_GREP_FAILED (correctness), and (2) the agent can inject ripgrep flags. ripgrep supports value flags in `--flag=value` form (a single token), including `--pre=<COMMAND>` (runs a preprocessor command per file) and `-f`/`--file` (read patterns from an arbitrary file), turning a read-only search tool into arbitrary command execution / arbitrary file disclosure outside the sandbox checks applied to `path`.

**Fix:** Pass the pattern via `-e` and terminate options before the path: `rg -n -e <pattern> -- <resolvedRoot>`. Using `-e` makes a leading-dash pattern a literal pattern and prevents flag injection.

*Verifier:* grep.js:13 calls captureProcess("rg", ["-n", pattern, resolvedRoot], ...) with the agent-controlled `pattern` as a bare positional, with no `-e`/`--regexp` and no `--` end-of-flags separator. utils.js captureProcess spawns via node:child_process spawn with stdio pipes and NO shell, so each array element is exactly one argv token but ripgrep still interprets any token starting with `-` as a flag. Correctness bug confirmed: a legitimate pattern like `-foo` is parsed by rg as an unknown flag -> exit code 2 -> the code at lines 19-24 throws SmithersError TOOL_GREP_FAILED, so dash-prefixed searches are impossible. Flag-injection is also real for single-token value flags: the pattern is one argv element so the agent can supply `--pre=<cmd>` (ripgrep runs the preprocessor command per searched file) or `--file=<path>` (reads patterns from an arbitrary path). With path defaulting to ".", resolvedRoot becomes rg's only remaining positional (used as the regex) while the injected `--pre=`/`--file=` flag takes effect, bypassing the resolveToolPath/assertPathWithinRoot sandbox that is only applied to `path`, not to `pattern`. Practical RCE via `--pre` is constrained (the value is a single token so the preprocessor cannot take its own args and must be a resolvable executable), which is why this is medium rather than high, but the flag-injection and the dash-pattern correctness failure are genuine defects. Standard fix: `["-n", "-e", pattern, "--", resolvedRoot]`.

### 137. [MEDIUM · correctness] `packages/time-travel/src/fork/_helpers.js:7`

**resetNodes fork does not invalidate downstream dependents, leaving stale outputs**

`expandResetSet` is documented as computing "the full transitive set including all downstream dependents... reset every node whose iteration >= the minimum iteration of the reset set", but the implementation only ever re-adds the exact named nodes: `const baseId = key.split("::")[0]; if (resetSet.has(baseId)) { result.add(key); }`. No downstream/iteration expansion happens. In `forkRunEffect.js` the reset only flips matched nodes to `{ state: "pending", lastAttempt: null }` (lines 68-75) while `outputsJson: source.outputsJson` is copied verbatim. When the forked run is resumed (CLI `smithers fork --run` calls `engine.runWorkflow(..., { resume: true, force: true })`, and `force` only bypasses the running-heartbeat check at engine.js:4692/4707, it does NOT force re-execution of completed nodes), nodes that consumed the reset node's output remain in `completed` state and are never re-run. The forked run therefore re-executes the reset upstream node but feeds its NEW output into downstream nodes that still hold OLD, now-inconsistent outputs. This silently produces a run whose downstream results do not reflect the reset/overridden inputs, defeating the purpose of fork-with-reset.

**Fix:** Either implement the documented downstream expansion (reset every node whose execution is causally after any reset node, e.g. via the dependency graph or the iteration>=min heuristic the comment describes) and clear the corresponding entries in outputsJson, or update the contract and require callers to pass the full downstream set explicitly. At minimum, also drop the stale output rows for nodes whose state was reset to pending.

*Verifier:* Confirmed from the actual code. expandResetSet (packages/time-travel/src/fork/_helpers.js:7-28) does NOT do any downstream/dependent expansion nor any iteration>=min logic that its docstring (lines 1-6) promises. It only iterates Object.keys(nodes), takes baseId=key.split('::')[0], and re-adds every key whose base id is literally in resetNodeIds (i.e. all iterations of the *named* nodes), plus an exact-key fallback when nothing matched. The committed test (rewindAuditHelpers.test.ts:125-133) only exercises the exact-key fallback, confirming this limited behavior is the real contract. In forkRunEffect.js:60-75 the returned keysToReset (OR'd with resetNodes.includes(n.nodeId), which is redundant) only flips the named nodes to {state:'pending', lastAttempt:null} while outputsJson:source.outputsJson is copied verbatim (line 82). I verified the engine does not compensate: on resume, force only bypasses the heartbeat/staleness check (engine.js:4692 `if (fresh && !opts.force)` and 4707 `requireStale: ... !opts.force`), it does NOT force re-execution of completed nodes; and the scheduler (scheduleTasks.js) treats finished/terminal nodes as done and only schedules pending/cancelled nodes, with no input-hash invalidation of completed downstream nodes (grep for inputHash/invalidate found nothing relevant). So forking with a reset of an upstream node leaves downstream completed dependents holding stale outputs that won't reflect the re-run/overridden upstream output. This is a genuine correctness gap and contradicts the function's own documented intent. Severity medium (not high): fork-with-reset is a niche time-travel feature and a user can manually name downstream nodes to reset; confidence medium because the user-visible impact depends on this intended-use path rather than an unconditional crash.

### 138. [MEDIUM · data-loss] `packages/time-travel/src/retry-task.js:63`

**resetDependents compares loop iteration across unrelated nodes, over-resetting valid work**

In resolveResetNodes, a candidate node is selected for reset (cancel attempts + delete output row + reset to pending) when `nodeIteration > targetIteration`:
```
const nodeIteration = node.iteration ?? 0;
...
if (nodeIteration > targetIteration) return true;
```
`iteration` is a per-node loop-iteration counter, and per the docs it 'equals the loop iteration only for a single, non-nested loop, and is 0 when several loops coexist' — i.e. each node's iteration reflects ITS OWN loop. Comparing a candidate node's iteration against the target node's iteration is only meaningful when both belong to the same loop. When two independent loops coexist, retrying a node in loop A at iteration 0 will match every node in loop B whose iteration reached >= 1, cancelling their attempts, deleting their output rows (deleteOutputRowEffect) and resetting them to pending inside the retry transaction. That discards completed, unrelated work. The intended dependents are downstream-of-target nodes; the iteration test should be scoped to the same loop, not applied globally.

**Fix:** Scope the `nodeIteration > targetIteration` rule to nodes within the same loop as the target (compare loop id / shared loop scope), or drop it in favor of an actual dependency-graph downstream check rather than a raw iteration comparison across all nodes.

*Verifier:* Confirmed in retry-task.js:58-70. The filter applies `if (nodeIteration > targetIteration) return true;` (line 63) globally to every node returned by adapter.listNodes(runId), with no scoping to the target's loop (no nodeId/loopId match). engine.js:1664 (`loop: { iteration: desc.iteration + 1 }`) confirms `iteration` is a per-loop counter: each independent/coexisting loop starts its body nodes at iteration 0 and increments independently. So when loops coexist, retrying a target at iteration 0 matches every node in any other loop with iteration >= 1, and the reset transaction (lines 156-203) cancels their attempts, deletes their output rows (deleteOutputRowEffect), and sets them to pending - discarding completed, unrelated work. The flaw is aggravated because this iteration early-return fires BEFORE the more reliable attempt-order (lines 65-68) and updatedAtMs (line 69) ordering checks, which would correctly exclude loops that finished before the target. resetDependents defaults to true (line 92), so the path is reachable on any retry of a multi-loop run. Severity reduced to medium because it only triggers when multiple loops coexist in one run (not the common single-pipeline case), and it is a best-effort retry heuristic rather than a guaranteed-on-every-run path.

### 139. [MEDIUM · data-loss] `packages/time-travel/src/revert.js:105`  _(corroborated ×2)_

**revertToAttempt truncates frames, snapshots and vcs-tags as three separate transactions (not atomic)**

After the VCS revert, the DB cleanup runs three independent `Effect.runPromise(...)` calls: `deleteFramesAfter` (107), `deleteSnapshotsAfter` (110), `deleteVcsTagsAfter` (111). Each adapter method is its own `withTransaction`, so they commit separately. The code's own comments state these MUST be discarded together or 'a later fork/replay can't resurrect reverted state.' A crash or error after `deleteFramesAfter` commits but before the snapshot/vcs-tag deletes commit leaves orphan `_smithers_snapshots` / `_smithers_vcs_tags` rows for frames that no longer exist, so a subsequent `forkRun`/`replayFromCheckpoint`/`loadLatestSnapshot`/`rerunAtRevision` can resurrect logically-discarded state. (jumpToFrame.js correctly performs all three deletes inside a single transaction at lines 745-750; revert.js does not.)

**Fix:** Run the three deletes inside one `adapter.withTransaction` (mirroring jumpToFrame.js lines 745-750) so frame/snapshot/vcs-tag truncation commits atomically.

*Verifier:* Confirmed. revert.js:107-111 runs deleteFramesAfter, deleteSnapshotsAfter, deleteVcsTagsAfter as three separate Effect.runPromise calls. Each adapter method (adapter.js:2551, 2567, 2581) wraps its mutation in its own self.write, so the three deletes commit independently — there is no enclosing withTransaction. The sister function jumpToFrame.js:726-750 wraps the identical three deletes inside a single input.adapter.withTransaction, exactly because the comments (revert.js:108-109; adapter.js:2559-2562, 2574-2576) state they must be truncated together or fork/replay/loadLatestSnapshot/rerunAtRevision can resurrect logically-discarded state. A crash (or error) after deleteFramesAfter commits but before the snapshot/vcs-tag deletes leaves orphan _smithers_snapshots/_smithers_vcs_tags rows keyed to deleted frames. withTransaction is available on the same adapter (used in jumpToFrame.js), so revert.js could and should have used it. Real atomicity/data-integrity gap; impact gated on a crash mid-cleanup, so medium rather than high.

### 140. [MEDIUM · logic] `packages/time-travel/src/timeline/buildTimelineEffect.js:26`

**Forks whose parent snapshot frame was pruned are silently dropped from the timeline (and its tree)**

buildTimeline indexes branches by `parentFrameNo` (`branchByFrame`), but fork points are only ever surfaced by mapping over the run's *snapshots*: `frames = snapshots.map(s => ({..., forkPoints: branchByFrame.get(s.frameNo) ?? []}))`. A branch whose `parentFrameNo` has no matching snapshot row is never read out of the map, so it disappears entirely. This is a real scenario: `deleteSnapshotsAfter(runId, frameNo)` (packages/db/src/adapter.js:2567) deletes rows from `_smithers_snapshots` with `frame_no > ?` but does NOT delete the corresponding `_smithers_branches` rows. So after a parent run reverts/time-travels (jumpToFrame.js:749, revert.js:110, timetravel.js:197 all call deleteSnapshotsAfter) past a frame where a child run forked, the branch row survives but its snapshot frame is gone. The child fork then vanishes from `frames[].forkPoints`. Worse, buildTimelineTreeEffect.js builds `childRunIds` exclusively from `frame.forkPoints`, so the entire orphaned child run and its whole subtree are omitted from the recursive timeline tree shown by `smithers timeline`/tree. A valid forked descendant run becomes invisible.

**Fix:** Collect child runs and fork points from the full `branches` list, not only from branches whose parentFrameNo has a surviving snapshot. In buildTimelineEffect, also expose orphaned branches (e.g. attach branches with no matching frame under a synthetic/last frame or a separate `orphanedForks` field); in buildTimelineTreeEffect, derive `childRunIds` from `branches`/all forkPoints rather than just `frame.forkPoints`. Alternatively, make deleteSnapshotsAfter also delete the dependent _smithers_branches rows so the data stays consistent.

*Verifier:* Confirmed in the real code. buildTimelineEffect.js builds `branchByFrame` keyed by `b.parentFrameNo` (lines 20-25) but only ever reads it via `snapshots.map(s => ({...forkPoints: branchByFrame.get(s.frameNo) ?? []}))` (lines 26-31). Any branch whose parentFrameNo has no matching snapshot row is never surfaced. The orphaning scenario is real: adapter.js `deleteSnapshotsAfter` only runs `deleteWhere('_smithers_snapshots','run_id = ? AND frame_no > ?')` and there is NO corresponding branch deletion anywhere — grep for deleteBranch/_smithers_branches in adapter.js returns nothing, and revert.js:110 / jumpToFrame.js:749 / timetravel.js:197 call deleteSnapshotsAfter without touching `_smithers_branches`. listBranches returns all rows by parent_run_id (no snapshot join), so a branch forked at frame N survives after the parent reverts to frame < N even though the frame-N snapshot is gone. buildTimelineTreeEffect.js then builds `childRunIds` exclusively from `frame.forkPoints`, so the orphaned child run and its entire subtree are recursively omitted from `smithers timeline`/tree. This is a genuine display-completeness defect: a valid forked descendant run becomes invisible. Severity medium rather than high because the child run itself is not deleted (no data loss — the run still exists in the DB and is reachable by id); only the tree/timeline rendering is incomplete, and it requires the specific sequence of fork-then-parent-revert-past-fork-frame.

### 141. [MEDIUM · concurrency] `packages/time-travel/src/timetravel.js:103`

**timeTravel and revertToAttempt have no run-liveness guard or single-flight lock while the engine may be driving the run**

`jumpToFrame` deliberately refuses to rewind a run whose owner PID is alive or whose heartbeat is fresh (jumpToFrame.js lines 527-543, `isRunLikelyLive`) and takes an in-process `acquireRewindLock`, because the rewind runs in a SEPARATE process from the engine and would otherwise race the engine's frame/attempt writes against the truncation. `timeTravel` (timetravel.js) and `revertToAttempt` (revert.js) perform the same class of destructive truncation (`deleteFramesAfter`, attempt cancellation, output deletion, run-status reset) but check neither liveness nor any lock. Both are exposed via the CLI (`smithers timetravel`, `smithers revert`) and MCP (`semantic-tools.js`), so a user can invoke them while `smithers up`/a served run drives the same runId in another process, corrupting frames/attempts and the shared working tree mid-flight.

**Fix:** Apply the same `isRunLikelyLive` refusal (with a `force` override) and/or `acquireRewindLock` guard used by jumpToFrame before mutating in timeTravel and revertToAttempt.

*Verifier:* Substantively real. jumpToFrame.js explicitly refuses to rewind a live run via isRunLikelyLive (PID alive OR fresh heartbeat, lines 527-543) AND takes an in-process single-flight acquireRewindLock (lines 546-559); isRunLikelyLive.js documents that the lock cannot coordinate across OS processes so the liveness check is required because the CLI/MCP rewind runs in a separate process from the engine. Confirmed that timetravel.js and revert.js perform the same destructive truncation (deleteFramesAfter/deleteSnapshotsAfter/updateAttempt cancel/deleteOutputRow/updateRun) but neither imports isRunLikelyLive nor acquireRewindLock (grep: none in either). Upstream mitigation exists but is weaker and incomplete: CLI 'timetravel' (index.js 5975-5980) and MCP 'time_travel' (semantic-tools.js 1537-1542) both guard on run.status==='running' && !force, but the CLI 'revert' command (index.js 5868) and MCP 'revert_attempt' (semantic-tools.js 1317-1318) have NO liveness/lock guard whatsoever, so a user can revert a live run while the engine drives it. Even the timetravel status guard is a coarse TOCTOU (status-only, no PID/heartbeat) with no single-flight lock, so two concurrent --force invocations (or revert+engine) race the engine's frame/attempt writes against the truncation. Real concurrency hazard; severity medium because the most common timetravel case is partially guarded and exploitation requires concurrent invocation or the unguarded revert path.

### 142. [MEDIUM · data-loss] `packages/time-travel/src/timetravel.js:184`

**timeTravel reverts the working tree BEFORE an unguarded DB transaction, diverging VCS and DB on failure**

`timeTravel` mutates the jj working copy first (lines 140-166: `revertToJjPointer(...)`, `vcsRestored = true`) and only afterwards runs the durable mutation in `await adapter.withTransaction("time-travel", ...)` (line 184) with NO try/catch. If the transaction rejects (any DB write error: locked db, constraint, disk) the function throws and the already-reverted working copy is left pointing at the old revision while the DB still shows the post-cutoff frames/attempts and the run un-rewound. There is also no in-progress audit/needs_attention marker, so a crash between the VCS revert and COMMIT leaves the same divergence with no recovery hook. This is inconsistent with the sibling paths `revertToAttempt` (revert.js) and `jumpToFrame` (jumpToFrame.js), which both detect the failure and call `markRunNeedsAttention`. Result: silent VCS/DB state divergence on the replay/restore path, the exact failure class time-travel is supposed to protect against.

**Fix:** Wrap the post-VCS DB transaction in try/catch; on failure re-restore the working copy (capture the pre-revert pointer) and/or call a `markRunNeedsAttention(adapter, runId, ...)` helper as revert.js does, returning {success:false}. Better: record an in-progress marker before the VCS mutation so startup recovery can flag interrupted time-travels.

*Verifier:* Confirmed real inconsistency. timeTravel reverts the jj working copy first (lines 140-166, vcsRestored=true) and only afterward runs adapter.withTransaction('time-travel', ...) at line 184 with NO surrounding try/catch (grep confirms 0 'try {' and 0 markRunNeedsAttention in timetravel.js). If the transaction rejects (locked db, constraint, disk), the function throws: the working copy is left reverted to the old revision while the (atomic) transaction rolls back, leaving DB frames/attempts and run status un-rewound -> VCS/DB divergence. Crucially, there is no needs_attention/recovery marker. The sibling revert.js handles the exact same failure class: it wraps the post-VCS DB cleanup in try/catch and calls markRunNeedsAttention (revert.js lines 105-129, 22-48), and jumpToFrame.js likewise calls markRunNeedsAttention on failure (line 950). timeTravel diverges from both, leaving silent divergence with no recovery hook. Severity adjusted to medium rather than high: it only triggers on a DB write error after a successful VCS revert, and the operation is largely retryable (revertToJjPointer is idempotent and the transaction recomputes the cutoff), but the missing needs_attention marker and the VCS-before-DB ordering are a genuine robustness gap relative to the sibling paths.

### 143. [MEDIUM · error-handling] `packages/usage/src/getUsageForAccounts.js:61`

**Failed (`source:"none"`) probes are cached, and the claude-code hard floor then serves the cached error and blocks re-probe even with --fresh**

`getUsageForAccounts` unconditionally writes every freshly produced report into the cache:
```js
reports.forEach((report, i) => {
  if (!decisions[i].useCache) {
    cache.entries[report.accountLabel] = { report };
    changed = true;
  }
});
```
Adapters degrade transient failures (network timeout, DNS blip, 429, 5xx) to a `{ source: "none", error }` report (see `claudeOauthUsage`/`codexWhamUsage` catch blocks). That error report gets persisted. The reuse decision is purely time-based and source-agnostic:
```js
const useCache = Number.isFinite(parsed) && (
  age < hardFloorMs(account.provider) ||           // 180_000 for claude-code
  (!fresh && age < refreshIntervalMs(account.provider))
);
```
Because `hardFloorMs("claude-code")` is 180_000 and applies even when `fresh` is true, a single transient probe failure for a claude-code account is cached and then re-served as a stale error for up to 3 minutes, and `smithers usage --fresh` cannot recover from it during that window. For other providers the soft TTL (30-180s) similarly serves the stale error on a normal (non-fresh) retry. The user sees a persistent error after one blip instead of a fresh attempt.

**Fix:** Do not cache reports whose `source === "none"` (or that carry a probe `error`), and/or make the hard-floor/TTL reuse decision skip cached entries whose stored report is an error so `--fresh` always re-probes a previously-failed account.

*Verifier:* Confirmed from code. buildUsageReport.js line 38 sets fetchedAt to a fresh ISO timestamp for ALL probes including source:'none' error reports. claudeOauthUsage.js degrades every failure (401/429/non-ok/thrown network-timeout-DNS at lines 42-53) to {source:'none', error} without throwing. getUsageForAccounts.js lines 61-66 write EVERY report where !useCache into cache.entries with no source/error filter, so error reports are persisted. The reuse decision (lines 50-53) is purely age-based and never inspects report.source/error; the age<hardFloorMs branch is OR'd in unconditionally, and hardFloorMs('claude-code')=180_000 applies even when fresh===true. Net: one transient claude-code probe failure is cached and re-served as a stale error for up to 180s, and `smithers usage --fresh` cannot recover during that window; other providers (hardFloor=0) serve the stale error on a non-fresh retry within the 30-180s soft TTL. The 429 case is arguably intentional protection, but caching unrelated transient network/DNS/timeout failures and serving them stale genuinely defeats the --fresh contract. Error-path-only and time-bounded, so medium severity is appropriate.

### 144. [MEDIUM · logic] `scripts/check-docs.mjs:3823`

**Six empty `required` doc-check entries become a no-op that secretly tests for the literal string "undefined"**

In `checkGatewaySdkDocsMatchExports` the `required` array contains six entries that list only the file path and omit the needle string (lines 3823-3825, 3826-3828, 3833-3835, 3836-3838, 3839-3841, 3842-3844), e.g.
```js
    [
      CUSTOM_WORKFLOW_UI_GUIDE,
    ],
```
These are consumed by `const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));`. For these entries `needle` is `undefined`, and `String.prototype.includes(undefined)` coerces the argument to the literal string "undefined", so the check effectively becomes `!content.includes("undefined")`.

Two concrete wrong behaviors:
1. The six intended documentation assertions are silently gone. They were meant to gate real content in `docs/guides/custom-workflow-ui.mdx` (the surrounding entries assert specific sentences about auth modes, devtools streaming, etc.). Because they were left empty, the corresponding doc regressions they were supposed to catch will pass undetected, defeating the purpose of the gate.
2. The check is now fragile/incorrect: it currently passes only because `docs/guides/custom-workflow-ui.mdx` happens to contain the word "undefined" 5 times (verified via grep: `data: ... | undefined`, `?? undefined`, etc.). If an editor removes those incidental "undefined" mentions from the doc, all six entries flip to `missing` and CI fails with the meaningless message `missing: docs/guides/custom-workflow-ui.mdx:undefined` repeated six times, with no way to understand or fix it from the message.

**Fix:** Either fill in the intended needle strings for these six entries or delete the empty entries entirely. Additionally, harden the filters to reject malformed entries, e.g. `required.filter(([file, needle]) => { if (typeof needle !== "string") throw new Error(`missing needle for ${file}`); return !files.get(file)?.includes(needle); })`, so an absent needle fails loudly at authoring time instead of silently coercing to "undefined".

*Verifier:* Confirmed real defect. In checkGatewaySdkDocsMatchExports the `required` array has six malformed one-element tuples (lines 3823-3825, 3826-3828, 3833-3835, 3836-3838, 3839-3841, 3842-3844) containing only CUSTOM_WORKFLOW_UI_GUIDE with no needle. Consumer at line 3880: `required.filter(([file, needle]) => !files.get(file)?.includes(needle))`. needle is undefined, and String.includes(undefined) coerces to includes('undefined'). I verified docs/guides/custom-workflow-ui.mdx currently contains 'undefined' 5 times, so all six entries evaluate to not-missing and the gate passes green while the six intended documentation assertions are dead no-ops. It is also fragile: removing the incidental 'undefined' tokens from the doc would flip all six to missing and emit the meaningless message `missing: .../custom-workflow-ui.mdx:undefined` six times. Genuine logic bug defeating six gate assertions.

### 145. [MEDIUM · resource-leak] `scripts/sandbox.ts:27`

**`sandbox up` overwrites the state file, orphaning a previously created VM**

The `up` branch unconditionally creates a new VM and then does `writeFileSync(STATE_FILE, JSON.stringify({ name, zone: ZONE }))` (line 27), with no check for an existing `.sandbox-vm`. If a VM is already recorded (the user ran `up` earlier and the SSH session ended without running `down`, or runs `up` twice), the create at line 19 still spins up a fresh GCE instance and line 27 clobbers the only record of the prior instance. `down` then reads the state file and deletes only the most recently recorded VM (line 36-38), so the earlier instance is leaked permanently and keeps accruing cloud cost with no way to find it via the script. Since `up` ends by launching an interactive SSH session and prints 'Run pnpm sandbox:down to delete the VM', running it again before tearing down is a realistic flow.

**Fix:** Before creating, check `if (existsSync(STATE_FILE))` and refuse (or auto-`down` the recorded VM first): error out with the existing VM name and tell the user to run `pnpm sandbox:down`, so an in-flight VM is never silently orphaned.

*Verifier:* Confirmed from the actual code. The `up` branch (lines 16-30) unconditionally calls `vmName()` (a fresh timestamp-derived name), runs `gcloud compute instances create` (line 19-26), then `writeFileSync(STATE_FILE, JSON.stringify({ name, zone: ZONE }))` (line 27) with NO `existsSync(STATE_FILE)` guard and no read of any prior recorded VM. `down` reads only the single record in STATE_FILE (line 36) and deletes only that one VM (line 38). So if a user runs `up`, the SSH session ends (line 29-30 explicitly returns control and instructs running down later), and they run `up` again, a second GCE instance is created and line 27 overwrites the only record of the first. The first instance is then unrecoverable via this script and keeps accruing cost. The vmName timestamp has second-level resolution so re-running quickly could even collide, but the core leak holds regardless. This is a genuine resource/cost leak. Severity capped at medium since it is a dev sandbox helper, not product code.

## LOW (125)

### 146. [LOW · error-handling] `apps/cli/src/agent-commands/runAgentAdd.js:150`

**pingAccount reports ran:true even when the CLI binary is missing or killed by signal**

pingAccount returns `{ ran: true, exitCode: result.status, cmd }` unconditionally after spawnSync (line 150-155). When the binary is not on PATH, spawnSync returns `{ status: null, error: <ENOENT Error> }` and never executed anything; pingAccount ignores `result.error` and reports `ran: true, exitCode: null`. The wizard then renders `→ non-zero exit (?)` (agentAddWizard.js:153) implying the CLI ran and failed, when in fact it could not be launched. Same null status occurs on signal termination. This produces a misleading health-check result.

**Fix:** Check `result.error`: if present, return `{ ran: false, exitCode: null, cmd }` (or surface the spawn error message) so a missing/unlaunchable binary is reported distinctly from a non-zero exit.

*Verifier:* pingAccount (lines 150-155) returns {ran:true, exitCode:result.status} without checking result.error. On ENOENT (subscription bin like claude/codex/kimi/agy not on PATH) spawnSync sets status=null and error, but the code still reports ran:true,exitCode:null. The wizard at agentAddWizard.js:153 then renders '-> non-zero exit (?)', falsely implying the CLI ran and failed when it could not launch. Reachable: the wizard pings after registering a subscription account (line 150-156). Contradicts the doc comment 'report whether the CLI starts cleanly'. Minor misleading-message defect, no crash; low severity.

### 147. [LOW · logic] `apps/cli/src/agent-detection.js:689`

**API-key-only agents mislabeled as 'likely-subscription' status**

`computeStatus` is called with `hasAuthSignal || hasProbeCredentialSignal` folded into the second (auth) argument: `const status = computeStatus(hasBinary, hasAuthSignal || hasProbeCredentialSignal, hasApiKeySignal);`. For an agent authenticated purely by API key (e.g. codex with a valid `sk-` `OPENAI_API_KEY` and no auth.json), the probe passes so `hasProbeCredentialSignal=true`, which makes the second arg true, and `computeStatus` returns 'likely-subscription' (score 4) instead of 'api-key' (score 3). This mislabels the status surfaced to the user and inflates the score used by `fallbackAgents`/`scoreStatus` ordering, so an API-key agent can outrank a genuine subscription agent in fallback selection.

**Fix:** Pass probe credential evidence as its own signal rather than collapsing it into the auth-signal slot, e.g. determine status from (hasAuthSignal) for subscription vs (hasApiKeySignal) for api-key independently, and only use the probe to gate `usable`/`hasCredentialSignal`, not to upgrade the status tier.

*Verifier:* Confirmed at line 689: computeStatus(hasBinary, hasAuthSignal || hasProbeCredentialSignal, hasApiKeySignal). For codex with valid sk- OPENAI_API_KEY and no auth.json: hasAuthSignal=false, hasApiKeySignal=true, probe passes (line 50-51) so hasProbeCredentialSignal=true -> second arg true -> computeStatus(true,true,true) returns 'likely-subscription' (line 590) score 4 instead of 'api-key' score 3. Real mislabel that inflates the score used by fallbackAgents/scoreStatus ordering. Low impact (mostly cosmetic + ordering).

### 148. [LOW · logic] `apps/cli/src/agent-wiring/parseAgentWiringArgv.js:18`

**Unknown value-taking flags are not skipped, so their value is misread as the command positional**

The parser only knows about `--agent`/`-a` and `--command`/`-c` as value-taking flags. For any OTHER flag it falls through every branch (it starts with `-`, so the final `else if (!tok.startsWith("-"))` is false and nothing happens), and the NEXT token is treated as a positional. incur has a global format flag (`-f`/`--format` — see index.js:6243 "--json collides with incur's format flag"), so `smithers mcp -f json add --agent hermes` parses as positionals ["mcp","json","add"] → cmd="mcp", sub="json", which fails the `sub !== "add"` check and returns null. The result is that all supplementary Hermes/OpenClaw/Pi wiring is SILENTLY skipped (the caller at index.js:7204 guards on `if (wiring && ...)`). Same breakage if the format flag precedes the subcommand: `smithers -f json mcp add` → positionals ["json","mcp","add"] → cmd="json" → null. The JSDoc explicitly promises "Unknown flags and their values are ignored," but values are consumed as positionals.

**Fix:** Maintain a set of known value-taking flags and skip the value of any unrecognized flag, or scan directly for the `mcp add`/`skills add` subcommand pair rather than relying on the first two entries of a flat positional list.

*Verifier:* The code defect is genuine. parseAgentWiringArgv (lines 18-36) only treats --no-global/--global, --agent/-a, --command/-c as value-taking. Any other flag starting with '-' matches no branch and is not consumed; the following token (not starting with '-') is pushed as a positional at line 34. Incur's global builtin value-taking flags pass through to this parser unstripped: confirmed in incur extractBuiltinFlags (Cli.js:1466-1535) for --format <v>, --filter-output <v>, --token-limit <v>, --token-offset <v>, --config <v>. The raw argv reaches parseAgentWiringArgv at index.js:7197 (rewrite helpers at 7118/7169/7175 do not remove them). So e.g. 'smithers --format json mcp add --agent hermes' yields positionals [json,mcp,add], cmd='json', sub mismatch -> returns null -> supplementary Hermes/OpenClaw/Pi wiring silently skipped (guard index.js:7206). JSDoc 'Unknown flags and their values are ignored' is inaccurate. CAVEATS lowering severity from the claimed medium: (1) the claim's specific '-f' example is wrong; incur has no '-f' short alias, only '--format'/'--json' (Cli.js:1482-1494), so the trigger is --format/--filter-output/etc., not -f; (2) the most common form (value flag AFTER 'add', e.g. 'mcp add --format json') works fine because the value lands as a harmless 3rd positional, as the existing passing test ['skills','add','--depth','2'] demonstrates. The break only fires when a value-taking flag precedes 'add', an uncommon ordering, and the consequence is a silent skip of best-effort wiring, not a crash/data loss/security issue.

### 149. [LOW · data-loss] `apps/cli/src/agent-wiring/registerOpenClawMcp.js:42`

**Missing Array.isArray guard on nested config objects can silently drop the servers map**

`const mcp = config.mcp && typeof config.mcp === "object" ? config.mcp : {}` and the analogous `mcp.servers` check (plus `mcp_servers` in registerHermesMcp.js:44) use only `typeof === "object"`, which is also true for arrays. If an existing `openclaw.json` had `mcp` as an array, `mcp` becomes that array, `mcp.servers = servers` sets a named property on the array, and `JSON.stringify` of an array drops non-index properties, silently losing the servers entry on write. registerHermesPlugin.js:85 correctly adds `&& !Array.isArray(...)`, so this omission is inconsistent.

**Fix:** Add `&& !Array.isArray(...)` to the `mcp`, `mcp.servers`, and `mcp_servers` type checks so an array shape falls back to a fresh {} instead of being mutated and corrupted.

*Verifier:* Lines 42-43: `config.mcp && typeof config.mcp === "object"` and `mcp.servers && typeof mcp.servers === "object"` both accept arrays (typeof [] === 'object'). If a pre-existing openclaw.json has `mcp` (or `mcp.servers`) as an array, the code sets `mcp.servers = servers` / `servers[name] = {...}` as a named property on an array object, then JSON.stringify(config) serializes the array with only numeric-index entries and silently drops the named property, losing the smithers server entry while returning registered:true. Verified against sibling files: registerHermesPlugin.js:85 correctly adds `&& !Array.isArray(config.plugins)`, while registerHermesMcp.js:44 shares the same omission, confirming the inconsistency. Genuine data-loss defect but only reachable with a malformed array-shaped config (uncommon), so low severity; no test exercises this case.

### 150. [LOW · correctness] `apps/cli/src/diff.js:96`

**Diff-stat undercounts content lines that begin with "--" or "++"**

countDiffLines (and the identical logic in packages/server/src/gatewayRoutes/getNodeDiff.js summarizeBundle) treats any line whose first three characters are all '-' as a '--- ' file header and skips it, and any line whose first three characters are all '+' as a '+++ ' header. The check is `ch === 45 && !(charCodeAt(cursor+1)===45 && charCodeAt(cursor+2)===45)` for removals, and the '+' equivalent for additions. But a *removed content line* whose own text starts with '--' produces a diff line like `--- comment` (one '-' prefix + content `-- comment`). This is extremely common: SQL comments (`-- comment`), C decrement statements (`--i;`), and similar. Such a removed line is silently NOT counted in the `removed` total. Symmetrically, an *added* content line beginning with '++' (e.g. C `++i;`) yields `+++i;` and is not counted in `added`. Result: `smithers diff --stat` reports too-few insertions/deletions for any patch touching such lines, and the per-file bar (`'+'.repeat(Math.min(added,20))`) is wrong too. git's real stat is accurate because it counts from file objects, not by re-parsing patch prefixes.

**Fix:** Distinguish real file headers from content by requiring the header form (e.g. only treat a line as a header when it starts with '--- ' / '+++ ' i.e. exactly three markers followed by a space, or better, track hunk state: only count +/- lines while inside an @@ hunk and treat lines starting with 'diff '/'index '/'--- '/'+++ ' as metadata). Apply the same fix to summarizeBundle in getNodeDiff.js.

*Verifier:* Confirmed at lines 93-96 of apps/cli/src/diff.js. The removal branch increments `removed` only when NOT(charCodeAt(cursor+1)===45 && charCodeAt(cursor+2)===45). A removed content line whose text starts with `--` (e.g. SQL `-- comment`) is emitted in a unified diff as a single `-` prefix plus the content, i.e. `--- comment`, whose first three chars are all `-`. The guard then treats it as a `--- a/file` header and skips it, so `removed` undercounts. Symmetrically the `+` branch (line 93) skips added lines beginning with `++` (e.g. `++i;` -> `+++i;`). Single-prefix content lines count correctly because the 2nd char differs. This function feeds summaryFromInput -> renderDiffStat (smithers diff --stat on a legacy DiffBundle), so totals and the per-file `+`/`-` bar (line 123) are wrong for any patch touching such lines. Real correctness defect, but limited to stat-output accuracy (no crash/data loss), so low severity.

### 151. [LOW · logic] `apps/cli/src/eval-suite.js:151`

**Greedy array matching in jsonContains produces false-negative eval failures**

`jsonContains` for arrays uses a greedy first-match: `const matchIndex = actual.findIndex((actualEntry, index) => !matchedActualIndexes.has(index) && jsonContains(actualEntry, entry)); ... matchedActualIndexes.add(matchIndex);`. This commits each expected element to the first unmatched actual element it matches, which can fail a valid overall matching. Example: expected `[{a:1}, {a:1,b:2}]`, actual `[{a:1,b:2}, {a:1}]`. Expected[0] `{a:1}` greedily claims actual[0] `{a:1,b:2}`; expected[1] `{a:1,b:2}` then has only actual[1] `{a:1}` left, which lacks `b:2`, so it returns false even though a valid matching exists (expected[0]->actual[1], expected[1]->actual[0]). This makes an `outputContains` assertion FAIL on a run that actually satisfies it, reporting a passing eval as failed.

**Fix:** Use a proper bipartite matching (e.g. backtracking / Hopcroft-Karp), or at minimum try expected entries with more constraints first; do not commit a greedy first match irrevocably.

*Verifier:* Lines 146-160: jsonContains array branch uses greedy first-unmatched matching (findIndex + matchedActualIndexes.add). Traced the claimed example expected [{a:1},{a:1,b:2}] vs actual [{a:1,b:2},{a:1}]: expected[0] greedily claims actual[0], leaving expected[1] {a:1,b:2} unable to match actual[1] {a:1}, so every() returns false despite a valid bipartite matching existing. This is a genuine algorithmic limitation causing a passing outputContains assertion to be reported as failed. Impact is real but requires overlapping subset-pattern arrays in the expected fixture, which is uncommon, so severity is low rather than medium.

### 152. [LOW · error-handling] `apps/cli/src/eval-suite.js:247`

**JSONL parse error reports wrong line number after blank-line filtering**

In `parseCasesText`, JSONL is processed as `text.split(/\r?\n/).map(trim).filter(Boolean).map((line, index) => { ... throw new SmithersError("INVALID_JSON", `Invalid JSONL case at line ${index + 1}: ...`) })`. Because `.filter(Boolean)` removes blank lines before `.map`, `index` is the position among non-empty lines, not the physical file line. With any leading/intervening blank lines, the reported `line ${index + 1}` points users to the wrong line in their file when a JSON record is malformed.

**Fix:** Capture the original line number before filtering, e.g. `text.split(/\r?\n/).map((line, i) => [i + 1, line.trim()]).filter(([, l]) => l).map(([lineNo, line]) => { try { return JSON.parse(line); } catch (err) { throw new SmithersError('INVALID_JSON', `Invalid JSONL case at line ${lineNo}: ...`, { line: lineNo }); } })`.

*Verifier:* Lines 238-249: .filter(Boolean) removes blank/whitespace lines BEFORE .map((line, index) => ...), so index is the position among non-empty lines. The thrown SmithersError uses `line ${index + 1}`, which therefore points to the wrong physical file line whenever blank lines precede a malformed JSON record. Confirmed real, but it only affects an error message's diagnostic accuracy, no functional/data impact, so low severity.

### 153. [LOW · logic] `apps/cli/src/fuzzy-select.js:124`

**limitOptions renders zero options on a terminal with <=4 rows**

`limitOptions` computes `const paneHeight = Math.max(rows - 4, 0); const windowSize = Math.min(paneHeight, Math.max(limit, 5));`. On a very short terminal where `rows <= 4`, `paneHeight` is 0, so `windowSize = Math.min(0, ...) = 0`. The subsequent `options.slice(slidingOffset, slidingOffset + 0)` returns an empty array, so even when `self.filtered.length > 0` the picker renders the query row and footer but NO options at all. The user sees a non-empty match count internally but an empty list and cannot visually pick anything. `terminalRows()` falls back to 24 only when `process.stdout.rows` is falsy (undefined/0), so a real reported height of 1-4 reaches here.

**Fix:** Floor the window to at least 1 row, e.g. `const windowSize = Math.max(1, Math.min(paneHeight || Infinity, Math.max(limit, 5)))`, or clamp paneHeight to a sensible minimum so at least the active option is always shown.

*Verifier:* Code at lines 124-125 confirms the claim: paneHeight = Math.max(rows-4, 0) is 0 when rows<=4, so windowSize = Math.min(0, Math.max(limit,5)) = 0. Line 134 options.slice(slidingOffset, slidingOffset+0) returns []. In renderPrompt (lines 276-287), filtered.length>0 takes the else branch but windowed is [], so windowed.join() yields '', rendering query row + footer with zero options. terminalRows() (line 143) returns process.stdout.rows||24, so a truthy reported height of 1-4 reaches limitOptions unchanged. The code literally exhibits the behavior. Severity is low: this faithfully reproduces clack's upstream limitOptions (docstring line 114 says 'EXACTLY'), and a <=4-row terminal cannot display the prompt's own header(2-3 lines)+query+footer regardless, so the picker is unusable there for reasons beyond this. Real but marginal edge case.

### 154. [LOW · error-handling] `apps/cli/src/hijack.js:224`

**Signal-terminated hijack child reported as exit code 0 (success)**

`child.on("close", (code) => resolve(code ?? 0));` resolves the returned exit code. When the spawned agent process (claude/codex/amp/etc.) is terminated by a signal (e.g. the user hits Ctrl-C, or it is SIGKILL/SIGTERM-ed), Node delivers `code === null` and instead passes a `signal` argument. This code ignores the signal and resolves `0`, so the caller treats a signal-killed/interrupted hijack session as a clean success. The conventional behavior is to surface a non-zero status (e.g. 128+signal). Concrete impact: the `smithers hijack` command exits 0 even though the handed-off agent was killed, masking interruption from scripts and the parent process.

**Fix:** Capture the signal: `child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));` (or 128 + os.constants.signals[signal]) so a signal-terminated child does not report success.

*Verifier:* Confirmed at hijack.js:224 `child.on("close", (code) => resolve(code ?? 0))`. Node passes code===null when a child is terminated by a signal, with the signal in the second arg (which is ignored here), so a signal-killed agent resolves to 0. The caller in index.js:4706 treats `exitCode === 0 && runIsLive` as a clean success and calls resumeRunDetached, and only fails (index.js:4714) when exitCode !== 0. Therefore a SIGTERM/SIGKILL of the hijacked agent is reported as success, smithers auto-resumes the run, and the CLI exits 0, masking the interruption. Real but minor: the common interactive Ctrl-C case usually SIGINTs the whole foreground process group (parent smithers dies too), so impact is limited to out-of-band signal termination. Conventional 128+signal would be correct.

### 155. [LOW · correctness] `apps/cli/src/index.js:737`

**Watch --interval clamp warning is spurious/misleading for non-integer seconds**

resolveWatchIntervalMsOrFail computes `const intervalMs = watchIntervalSecondsToMs(intervalSeconds)` (which is `clampWatchIntervalMs(intervalSeconds * 1000)` = `Math.max(Math.floor(intervalSeconds*1000), 500)`), then does `if (intervalMs !== intervalSeconds * 1_000)` to decide whether to warn. Two problems: (1) For fractional `--interval` values the floating-point product can differ from the floored result even when NO real clamping happened (e.g. `2.2 * 1000 === 2200.0000000000005`, `Math.floor` -> 2200, so `2200 !== 2200.0000000000005` fires a bogus warning). (2) The warning text is hardcoded to `clamped to ${WATCH_MIN_INTERVAL_MS}ms` (i.e. '500ms') even when the actual effective interval was produced by flooring to some other value (e.g. 1500ms), so the user is told the interval was clamped to 500ms when it was not. Net effect: a misleading/incorrect stderr message; the returned interval itself is correct so behavior is otherwise unaffected.

**Fix:** Compare against the actual clamp/floor result instead of the raw product, and report the real value. For example compute `const requested = Math.floor(intervalSeconds * 1000)` and warn only when `intervalMs !== requested`, and interpolate `intervalMs` (the effective value) into the message rather than the constant WATCH_MIN_INTERVAL_MS.

*Verifier:* Confirmed at index.js:736-741. watchIntervalSecondsToMs = clampWatchIntervalMs(intervalSeconds*1000) = max(floor(x*1000),500). The warning fires on `intervalMs !== intervalSeconds*1000`. For fractional seconds the float product differs from the floored value (e.g. 2.2*1000=2200.0000000000005, floor=2200) so a bogus warning fires though no clamping happened, and the hardcoded text 'clamped to 500ms' is wrong when the effective interval was floored to e.g. 1500ms. Returned interval is correct, so impact is only a misleading stderr message.

### 156. [LOW · error-handling] `apps/cli/src/index.js:1185`

**`smithers ps` does not guard `computeRunStateFromRow`, so one failing run can crash the whole listing**

`buildPsRows` calls `const view = await computeRunStateFromRow(adapter, run);` unguarded inside the per-run loop. `computeRunStateFromRow` performs additional DB reads (`listPendingApprovals`, `listNodes`, `listAttempts`, etc.) that can reject. The sibling `buildInspectSnapshot` deliberately wraps the same call defensively: `await computeRunStateFromRow(adapter, run).catch(() => undefined)` (line 1341). The inconsistency means a transient/partial-data failure for a single run rejects the entire `ps` command rather than rendering the remaining runs.

**Fix:** Mirror the inspect path: wrap the call with `.catch(() => undefined)` and fall back to `run.status`-derived state for that row so `ps` degrades gracefully instead of failing the whole command.

*Verifier:* Confirmed: buildPsRows (index.js:1187) calls `await computeRunStateFromRow(adapter, run)` unguarded in the per-run loop, while buildInspectSnapshot (index.js:1343) wraps the identical call with `.catch(() => undefined)`. computeRunStateFromRow does additional DB reads that can reject, so one failing/partial run rejects the whole `ps` listing. Inconsistent with the defensive sibling.

### 157. [LOW · security] `apps/cli/src/index.js:2385`

**Gateway startup log falsely claims 'bound to loopback' when an insecure non-loopback bind has no auth**

After listening, the gateway prints: `auth ? 'token required' : 'Auth: NONE — bound to loopback ${options.host}; do not expose this port'`. The no-auth branch is reached whenever `auth` is undefined, which includes the `--insecure` override path where `options.host` is explicitly a non-loopback address (the guard at lines 2318-2320 only throws when `!options.insecure`). In that case the operator deliberately bound a full-control, unauthenticated control plane to a public interface, yet the log reassures them it is 'bound to loopback', contradicting reality and hiding the real exposure.

**Fix:** Compute the loopback status (reuse `isLoopback` from runGatewayCommand) and tailor the message: for non-loopback no-auth binds print an explicit warning like 'Auth: NONE and bound to NON-loopback <host> (--insecure) — this control plane is exposed to the network'.

*Verifier:* Confirmed at index.js:2387-2389. The guard at 2320 only throws for non-loopback when `!options.insecure`. With --insecure + non-loopback host + no token, auth is undefined, so the log prints 'Auth: NONE — bound to loopback ${options.host}' even though options.host is non-loopback. Misleading message that hides the real exposure.

### 158. [LOW · logic] `apps/cli/src/index.js:3342`

**Devtools arg validator treats the token after any `--flag` as its value, even for boolean flags**

In `validateDevtoolsArgv`, the branch `else if (token.startsWith("--") && idx + 1 < rest.length && !rest[idx + 1].startsWith("-")) { value = rest[idx + 1]; }` consumes the following token as a value for EVERY `--flag`, including boolean flags (`--watch`, `--yes`, `--stat`, `--pretty`, `--json`). It also never advances `idx`, so the consumed token is then re-pushed as a positional on the next loop iteration. For value-taking flags (`--frame`, `--color`, `--iteration`, `--depth`, `--node`) the value token gets double-counted as a positional, inflating `positionals.length`. The net effect is that genuinely-missing required arguments slip past this custom validator (e.g. `smithers diff --color always run1` is missing `nodeId`, but `always` is counted as a positional so `positionals.length >= 2` passes), so the user gets Incur's generic downstream error instead of the intended custom usage message + exit(1). It cannot reject valid input (it only over-counts), so impact is degraded error UX, not a crash.

**Fix:** Maintain a set of known boolean flags per command and do not consume a value for them; for value flags, advance `idx` after capturing the value so it is not also pushed as a positional.

*Verifier:* Confirmed at index.js:3344-3347. For any `--flag` with a following non-dash token, value=rest[idx+1] is set but idx is NOT advanced, so the value token is pushed as a positional next iteration. For value-taking flags this double-counts the value as a positional, inflating positionals.length, so a genuinely-missing required arg (e.g. `diff --color always run1` missing nodeId) passes `positionals.length < required`. Can only over-count (never reject valid input), so impact is degraded error UX, not a crash.

### 159. [LOW · error-handling] `apps/cli/src/index.js:4098`

**resolveWatchIntervalMsOrFail failure does not abort the command**

`resolveWatchIntervalMsOrFail` returns `fail({...})` (i.e. `c.error(...)`, after setting `commandExitOverride`) on an invalid interval rather than throwing. Callers assign its return value but never check/return on the error path: events (`watchIntervalMs = resolveWatchIntervalMsOrFail("events", ...)`, line 4098), inspect (line 4757), node (line 4825). Execution continues into `runWatchLoop`, which re-validates via `watchIntervalSecondsToMs` and throws on an invalid interval. That rejected Effect then propagates: for inspect/node it is caught by the outer catch and re-failed with INSPECT_FAILED/NODE_DETAIL_FAILED (exitCode 1), overwriting the correct exitCode 4 from the first `fail` and emitting a second error object; for events (whose main try has only a `finally`, no `catch`) the rejection escapes the generator entirely. The user gets a confusing/duplicated error and an inconsistent exit code.

**Fix:** Have callers detect failure and return immediately, e.g. capture the result and `if (commandExitOverride) return errResult;`, or make resolveWatchIntervalMsOrFail throw a SmithersError that the existing catch handles, so the command stops before reaching runWatchLoop.

*Verifier:* The missing-return is real: events (4100), inspect (4759), node (4827) assign resolveWatchIntervalMsOrFail's result without checking the error path, then proceed into runWatchLoop which re-validates and throws. However the interval option is z.number().positive() and Zod v4 rejects 0/negative/NaN/Infinity (verified), so the only reachable trigger is a finite-but-overflowing value like --interval 1e308 (x*1000 -> Infinity -> clampWatchIntervalMs throws). So the realistic 'invalid interval' cases the claim describes are zod-guarded; only an absurd overflow reaches it, yielding a wrong exit code (1 vs 4)/duplicate error. Genuine but extremely narrow defect.

### 160. [LOW · correctness] `apps/cli/src/index.js:4861`

**`smithers node --format jsonl` (non-watch) prints human text instead of structured output**

The non-watch path of the `node` command only special-cases `json`:
```js
if (c.format === "json") {
    return c.ok(detail);
}
const rendered = renderNodeDetailHuman(detail, ...);
return c.ok(rendered, {...});
```
With `--format jsonl` the code falls through and returns `renderNodeDetailHuman(...)` (human-readable text). Every other place in this file treats jsonl as structured output equivalent to json (e.g. the same command's watch path at line 4816 does `c.format === "json" || c.format === "jsonl" ? undefined : renderNodeDetailHuman(...)`, and lines 4994/5284/5329 use the same `json || jsonl` guard). So a jsonl consumer of `smithers node` gets human prose instead of machine-parseable output, breaking scripted use.

**Fix:** Change the condition to `if (c.format === "json" || c.format === "jsonl") { return c.ok(detail); }` to match the watch path and the other commands.

*Verifier:* Confirmed at index.js:4863-4869. The non-watch node path only special-cases `c.format === 'json'`; with --format jsonl it falls through to renderNodeDetailHuman (human text). The same command's watch path (4818) and lines 4994/5284/5329 use the `json || jsonl` guard, so jsonl is meant to be structured. A jsonl consumer of `smithers node` gets human prose.

### 161. [LOW · correctness] `apps/cli/src/index.js:5702`

**down reports skipped (still-live) runs inside the `runs` array as if acted upon**

In `down`, when some runs are cancelled and others skipped (fresh heartbeat, no --force), the success payload is `c.ok({ cancelled, skipped, runs: allActive.map((r) => r.runId) }, ...)`. `runs` is mapped from `allActive`, which still contains the runs that were skipped at lines 5665-5669 (`skipped++; continue;`). So `runs.length` can exceed `cancelled`, and a consumer/script reading `runs` (paired with the cta 'Verify all runs stopped') is told live runs were stopped when they were intentionally left running. The accurate set is only the runs that hit the cancel/flip branches.

**Fix:** Accumulate the run IDs that were actually cancelled (push into an array in the cancel/flip branches) and return that array as `runs`, rather than mapping over `allActive`.

*Verifier:* Confirmed at index.js:5704. The success payload maps `runs: allActive.map(r => r.runId)`, and allActive still contains runs that were skipped (fresh heartbeat, no --force) at 5667-5671. So runs.length can exceed cancelled and the array lists still-live runs alongside the CTA 'Verify all runs stopped', misreporting intentionally-left-running runs as acted upon.

### 162. [LOW · correctness] `apps/cli/src/index.js:5759`

**graph JSON replacer drops repeated (non-cyclic) object references, silently losing data**

The `graph` command serializes the rendered snapshot with `JSON.parse(JSON.stringify(snap, (key,value) => { ... if (typeof value === 'object' && value !== null) { if (seen.has(value)) return undefined; seen.add(value); } return value; }))`. The `seen` WeakSet accumulates EVERY object ever visited, not just ancestors on the current path. JSON.stringify offers no 'leaving node' hook, so this classic anti-pattern treats any object that legitimately appears twice (a shared/DAG reference, e.g. a reused default/empty array, a shared props/config object, or the same value referenced from two nodes) as if it were a cycle and replaces the second+ occurrences with `undefined`. The result is silently incomplete/incorrect `graph` output rather than a faithful structure dump (the very thing `graph` exists to produce, including with `--compact` for compile validation). A proper cycle guard must remove objects from the set when leaving them (or track an ancestor path).

**Fix:** Use a true ancestor-path cycle detector (e.g. a recursive clone that adds to a Set before recursing into a value and deletes after), or a library like flatted, instead of a global WeakSet inside the JSON.stringify replacer.

*Verifier:* Confirmed at index.js:5759-5772. The graph replacer adds every visited object to a `seen` WeakSet and never removes it on leave (JSON.stringify has no leave hook), so any object legitimately referenced twice (shared/DAG reference) is replaced with undefined on its 2nd+ occurrence, not just true cycles. This silently drops data from the structure dump. Whether it bites depends on the rendered snapshot actually containing shared references, hence medium confidence; the anti-pattern itself is unambiguous.

### 163. [LOW · performance] `apps/cli/src/index.js:7103`

**writeFdSync busy-spins at 100% CPU on EAGAIN backpressure**

In writeFdSync, the EAGAIN branch does `if (code === "EAGAIN") continue;` which immediately retries the same writeSync without yielding or waiting for the fd to become writable. When fd 1/2 is a non-blocking pipe whose reader is slow (the exact large-output-to-pipe scenario this helper exists to handle, e.g. `docs-full --json`), writeSync keeps returning EAGAIN until the reader drains the OS buffer. The loop therefore spins a CPU core at 100% for the entire duration of backpressure instead of blocking. This is observable as a pegged core whenever a downstream consumer reads slowly from a large piped payload.

**Fix:** On EAGAIN, block until the fd is writable before retrying, e.g. poll/select on the fd, or set the fd back to blocking mode for the synchronous write (fs.fchmod is not it; use a brief synchronous wait such as Atomics.wait on a SharedArrayBuffer or a tiny blocking sleep), rather than a tight `continue`.

*Verifier:* Confirmed at index.js:7099-7108. The EAGAIN branch does `continue`, immediately retrying writeSync with no yield/wait. On a non-blocking fd 1/2 pipe with a slow reader, writeSync returns EAGAIN repeatedly and the loop busy-spins a core at 100% for the duration of backpressure (the exact large-output-to-pipe scenario this helper handles). Medium confidence because it depends on the fd being non-blocking, which is the premise this code path was written for.

### 164. [LOW · correctness] `apps/cli/src/init-command.js:61`

**Init CTA tip always claims the smithers skill was installed, even with --no-skill or when no agent was detected**

`buildInitCta` unconditionally returns `tip: "New here? Your coding agent now has the smithers skill ..."` regardless of whether the skill was actually installed. The skill install is gated by `c.options.skill` (settable to false via `--no-skill`) and by agent detection inside `installCuratedSkill` (which skips all targets when no agent is present, e.g. on a CI box with no coding-agent config dirs and returns `installed: []`). In both cases `result.skill.installed` is empty, yet `runInitCommand` still surfaces this tip via `renderInitNextSteps(cta)` (human path) and via `c.ok(result, { cta })` (piped/agent path). The user/agent is told a skill exists that was never written, which can lead an agent to look for or rely on a skill that is absent.

**Fix:** Make the tip conditional on the actual install result. Pass the install outcome (e.g. `result.skill?.installed?.length > 0`) into `buildInitCta` and only include the skill tip when at least one skill was installed; otherwise omit it or use a neutral tip.

*Verifier:* buildInitCta (apps/cli/src/init-command.js:47-63) takes only templateResult and uses it only for the commands list; the tip at line 61 is a constant string 'Your coding agent now has the smithers skill' with no check of result.skill, c.options.skill, or detection state. The CTA is built at line 104 gated only by c.options.agentsOnly, so it is produced regardless of --no-skill. With --no-skill, c.options.skill=false propagates as installSkill:false, and workflow-pack.js:4617 (`if (options.installSkill && !options.agentsOnly)`) means installCuratedSkill is never called, so no skill is written, yet the tip still claims it. With no agent detected, installCuratedSkill (installCuratedSkill.js:111-115) returns installed:[] (all targets pushed to skipped 'not-detected'), yet the same tip is surfaced via renderInitNextSteps(cta) (line 111) and c.ok(result,{cta}) (line 114). Genuine but minor: misleading message only, no crash/data loss; an agent could look for an absent skill.

### 165. [LOW · logic] `apps/cli/src/mcp/semantic-tools.js:1687`

**Chat transcript tie-break sorts numeric event ids lexicographically, misordering same-timestamp messages**

In get_chat_transcript the messages are sorted by timestampMs, with a tie-break of `return left.id.localeCompare(right.id);` (line 1687). Message ids for streamed output are `event:${event.seq}` (line 1651), where seq is a monotonically increasing integer. localeCompare compares these as strings, so for messages produced in the same millisecond, `event:10` sorts before `event:2` (and before `event:9`), reversing the true chronological order given by seq. High-throughput agent stdout (many NodeOutput events sharing a timestamp ms) is exactly the case where multiple events tie on timestampMs, so the returned transcript can present assistant output lines out of order. The same applies to mixing `prompt:`/`response:`/`event:` ids when timestamps tie.

**Fix:** Tie-break numerically on the underlying seq for event messages instead of string-comparing ids, e.g. carry a numeric `seq` on each message and compare it (falling back to a stable secondary key like source priority) rather than `left.id.localeCompare(right.id)`.

*Verifier:* Confirmed. The tie-break at line 1687 is `left.id.localeCompare(right.id)`. Event message ids are `event:${event.seq}` (line 1651) where seq is a monotonically increasing integer. Default localeCompare (no {numeric:true}) does lexicographic string comparison, so 'event:10' sorts before 'event:2' and 'event:9', reversing true chronological seq order. This only bites when multiple events share the same timestampMs, which is realistic for high-throughput NodeOutput stdout in one millisecond, so the transcript can present lines out of order. Real but minor ordering defect; non-crashing, read-only tool.

### 166. [LOW · data-loss] `apps/cli/src/node-detail.js:524`

**Node-level tokenUsage rollup always reports empty models/agents**

The aggregate `totalUsage` is built by reducing over `attemptsDetailed` with `mergeTokenUsage`, but each synthetic event passes `model: null, agent: null` (lines 524-525):
```js
const totalUsage = attemptsDetailed.reduce((acc, attempt) => mergeTokenUsage(acc, {
    attempt: attempt.attempt,
    model: null,
    agent: null,
    ...
}), emptyTokenUsage());
```
`mergeTokenUsage` only adds to its model/agent sets `if (event.model)` / `if (event.agent)` (lines 142-147), so the node-level `tokenUsage.models` and `tokenUsage.agents` are ALWAYS `[]`, even though the underlying TokenUsageReported events carry real model/agent names (the per-attempt `byAttempt[].usage.models` is populated correctly, confirmed by the unit test asserting `models: ["gpt-test"], agents: ["codex"]`). The accumulation logic in mergeTokenUsage for models/agents is dead code on the rollup path. Any consumer that reads the node-level aggregate (e.g. `smithers node --json` output, gateway UI showing which models a node used) sees an empty list and loses the information, while every other field (tokens, cost) rolls up correctly. This is an inconsistency/data-loss defect, not just style: the field exists in the EnrichedNodeDetail type and is meant to be populated.

**Fix:** Aggregate the model/agent sets from the per-attempt usages explicitly, e.g. after computing totalUsage do `totalUsage.models = [...new Set(attemptsDetailed.flatMap(a => a.tokenUsage.models))]` and the same for agents, or pass the joined model/agent through the reduce instead of hardcoding null.

*Verifier:* Confirmed in real code. Lines 520-530: totalUsage = attemptsDetailed.reduce((acc, attempt) => mergeTokenUsage(acc, { attempt, model: null, agent: null, inputTokens: attempt.tokenUsage.inputTokens, ... })). The synthetic event passes model:null and agent:null and only copies numeric token/cost fields from attempt.tokenUsage, never attempt.tokenUsage.models/agents. mergeTokenUsage (lines 141-147) only adds to nextModels/nextAgents `if (event.model)` / `if (event.agent)`, so with null values nothing is added. The node-level tokenUsage (lines 531-537) spreads totalUsage, so detail.tokenUsage.models and .agents are always []. The type NodeDetailTokenUsage (confirmed via NodeDetailTokenUsage.ts) declares models: string[] and agents: string[], and EnrichedNodeDetail.tokenUsage = NodeDetailTokenUsage & { byAttempt }, so the field is meant to be populated. Per-attempt byAttempt[].usage.models/agents are correctly populated (built from parseTokenUsageEvent which sets model/agent, merged in the tokenByAttempt loop lines 463-473). So numeric tokens and cost roll up correctly while models/agents are silently dropped at the node aggregate level. Genuine data-loss/inconsistency, though impact is limited to a display/metadata field (low severity).

### 167. [LOW · error-handling] `apps/cli/src/restore.js:27`

**defaultRevert discards spawn failure cause, reports misleading "code null"**

In `defaultRevert`, `spawnSync(bin, ...)` does NOT throw when the jj binary is missing or the process is killed by a signal; it returns an object with `res.error` set and `res.status === null` (and `res.stdout`/`res.stderr` null). The failure branch is `return Promise.resolve({ success: false, error: (res.stderr || \`jj exited with code ${res.status}\`).trim() })`. When `res.status` is null, `res.stderr` is null too, so the user sees the literal string "jj exited with code null" and the real cause carried in `res.error` (e.g. ENOENT 'jj not found', or the terminating signal) is silently dropped. runRestoreOnce then prints `Restore failed: jj exited with code null` and exits 1 with no actionable diagnostic.

**Fix:** Surface res.error/res.signal: e.g. `const reason = res.error ? res.error.message : res.signal ? \`jj terminated by ${res.signal}\` : (res.stderr || \`jj exited with code ${res.status}\`); return Promise.resolve({ success: false, error: String(reason).trim() });`

*Verifier:* Confirmed at lines 25-27 of apps/cli/src/restore.js. spawnSync does not throw on spawn failure; when the resolved jj binary is missing it returns res.error set (ENOENT), res.status === null, and res.stdout/res.stderr === null. Line 27 builds the error from `res.stderr || `jj exited with code ${res.status}``, so with stderr null and status null the user sees literally 'jj exited with code null'. res.error (the actual cause: ENOENT or terminating signal) is never read and is dropped. runRestoreOnce (line 77) then prints 'Restore failed: jj exited with code null' and returns exitCode 1 with no actionable diagnostic. Real but low-impact: only a misleading error message; no crash, data loss, or security issue.

### 168. [LOW · concurrency] `apps/cli/src/token-store.js:214`

**resolveSmithersActionTokenFromStore does a read-modify-write of the whole token store with no locking**

`resolveSmithersActionTokenFromStore` reads the entire store from disk, mutates it (appends an `action_used` audit entry via `resolveSmithersActionToken`), then `writeSmithersTokenStore(store)` rewrites the whole `tokens.json`. Combined with `issueSmithersBrokerToken`/`revokeSmithersToken` (also full read-modify-write in index.js), two concurrent CLI/gateway invocations race: process A reads the store and issues a new token; process B (resolving an action token) read an older snapshot and writes it back, clobbering A's newly issued token and any concurrently-appended audit entries (last-write-wins). Because the file holds bearer-token grants and the security audit log, this can silently drop tokens or audit records. There is no file lock or atomic compare-and-swap.

**Fix:** Serialize writes with an exclusive lock file (or O_EXCL temp-file + atomic rename with a retry on conflict), or only persist on a dedicated path rather than rewriting on every resolve.

*Verifier:* Confirmed in source. resolveSmithersActionTokenFromStore (lines 214-218) calls readSmithersTokenStore() -> resolveSmithersActionToken() which appendAudit's an 'action_used' entry (line 204) -> writeSmithersTokenStore(store) which does a plain non-atomic writeFileSync of the entire tokens.json (line 106). issueSmithersBrokerToken (116-152) and revokeSmithersToken (221-240) are likewise full read-modify-write over the same file with no lock or compare-and-swap. Two concurrent invocations (e.g. `smithers exec` resolving an action token while `smithers token` issues a new one) read independent snapshots and the later writeFileSync clobbers the earlier process's newly-issued token / revocation / audit entries (last-write-wins). The file holds bearer grants and the security audit log, so silent token/audit loss is possible. Real concurrency defect, but low severity: the writers are mostly manual/interactive CLI commands so the concurrent window is narrow in practice.

### 169. [LOW · logic] `apps/cli/src/tree.js:270`

**Reconnect backoff skips the first (200ms) tier — off-by-one on attempt index**

In `runTreeWatch`, `attempt` starts at 0 and is incremented BEFORE the delay is computed: `attempt += 1; const delay = backoffMs(attempt);`. `backoffMs(attempt)` indexes `WATCH_RECONNECT_BACKOFF_MS = [200, 500, 1000, 2000, 5000]` with `Math.min(attempt, len-1)`. Since the first reconnect calls `backoffMs(1)`, the very first retry waits 500ms and the documented 200ms entry (index 0) is dead code that is never used. The comment explicitly states the bounds are 'kept small so `--watch` feels responsive on transient server restarts' — the intended fast first retry never happens. Concrete effect: every transient server blip costs an extra ~300ms before the first reconnect attempt, and the backoff schedule is effectively [500,1000,2000,5000,5000] instead of [200,500,1000,2000,5000].

**Fix:** Compute the delay before incrementing, e.g. `const delay = backoffMs(attempt); attempt += 1; ...` so the first reconnect uses index 0 (200ms), or call `backoffMs(attempt - 1)`.

*Verifier:* Confirmed in apps/cli/src/tree.js. `attempt` initialized to 0 (line 218) and reset to 0 on each successful snapshot/delta (lines 237, 242). In the catch block, line 270 `attempt += 1` runs BEFORE line 271 `const delay = backoffMs(attempt)`. backoffMs (line 186-189) indexes WATCH_RECONNECT_BACKOFF_MS=[200,500,1000,2000,5000] with Math.min(attempt, 4). Since the first reconnect always calls backoffMs(1)=500ms, index 0 (200ms) is never used as a delay. Effective schedule is [500,1000,2000,5000,5000], not the intended [200,500,1000,2000,5000], contradicting the responsiveness comment at lines 181-182. Genuine off-by-one, but cosmetic impact (~300ms slower first retry); correctly rated low.

### 170. [LOW · logic] `apps/cli/src/workflow-pack.js:1008`

**sync-features-write prompt tells agent to mkdir wrong directory**

The generated prompt instructs the agent to write `.smithers/specs/features.ts` (lines 1006/1048) but the setup step says `First create the directory: mkdir -p specs` (line 1008). When the agent runs from the repo root, `mkdir -p specs` creates `./specs`, not `./.smithers/specs`, so the subsequent write to `.smithers/specs/features.ts` targets a directory that was not created (or the agent silently writes the file to the wrong `specs/` location). The header and final instruction both reference `.smithers/specs/...`, so the mkdir is inconsistent with the intended path.

**Fix:** Change line 1008 to `First create the directory: mkdir -p .smithers/specs` so it matches the target path .smithers/specs/features.ts.

*Verifier:* Confirmed at lines 1006/1008/1048. The prompt body says 'Write the file .smithers/specs/features.ts' and the report step references '.smithers/specs/features.ts', but the setup instruction at 1008 literally says 'First create the directory: mkdir -p specs'. From repo root that creates ./specs, not ./.smithers/specs. The mkdir instruction is genuinely inconsistent with the target path. Low impact (a capable agent may self-correct), but the emitted instruction is wrong.

### 171. [LOW · correctness] `apps/cli/src/workflow-pack.js:1325`

**ForEachFeature feature-granularity work-item ids can collide producing duplicate graph node ids**

In `granularity === "feature"`, work item ids are `${slugifyFeatureToken(groupName)}:${slugifyFeatureToken(feature)}:${index}` (line 1325). slugifyFeatureToken collapses any non-alphanumeric run to a single `-`, so two distinct group names (e.g. `FOO_BAR` vs `FOO__BAR`) slugify to the same token; combined with an identical feature name at the same per-group index this yields the same work-item id, hence two Task nodes with the same `id={`${idPrefix}:group:${item.id}`}` and ambiguous mergeNeeds entries pointing at the same node. Group ids `${slugify(groupName)}:${index}` use the global group index so they are safe, but the feature path uses the per-group index and is not. Inputs are agent-generated SCREAMING_SNAKE_CASE so collisions are unlikely but possible.

**Fix:** Use a globally-unique counter (the flatMap running index) in the feature-granularity id instead of the per-group `index`, e.g. include the overall work-item position to guarantee uniqueness.

*Verifier:* Real code asymmetry at line 1325: in feature granularity the id is `${slug(groupName)}:${slug(feature)}:${index}` where index is the PER-GROUP index (line 1324 maps within each group), while the group path at 1331 uses the GLOBAL group index. slugifyFeatureToken (1304-1310) collapses any non-alphanumeric run to '-', so two distinct group names that slugify identically (e.g. trailing-underscore variants) with the same feature at the same per-group position yield identical work-item ids -> duplicate Task id at 1364. The defect exists in code, but triggering it needs two SCREAMING_SNAKE group names that slug-collide AND a shared feature at the same index, which is very unlikely with valid inputs.

### 172. [LOW · error-handling] `apps/cli/src/workflow-pack.js:2303`

**plan.tsx / vcs.tsx launch and cancel swallow errors (unhandled rejection, no user feedback)**

The plan UI `launch`/`cancel` (and vcs UI `launch`) wrap their awaited actions in `try { ... } finally { setBusy(false); }` with NO catch, and are invoked as `onClick={() => void launch()}`. If `actions.launchRun`/`cancelRun` rejects (gateway down, validation error), the rejection is discarded by `void`, producing an unhandled promise rejection and giving the user no indication the action failed (the button just un-busies). The kanban UI in the same file correctly does `catch (e) { notify(String(e)); }`. This is an inconsistent, error-dropping path in the generated plan/vcs UIs.

**Fix:** Add a `catch` that surfaces the error to the user (toast/inline message) as the kanban renderer does, rather than relying on `void` to discard the rejection.

*Verifier:* Confirmed. plan launch/cancel (2303-2322) use try{...}finally{setBusy(false)} with NO catch, and buttons invoke them as onClick={() => void launch()}/void cancel() (lines 2345-2347, 2376) and vcs onClick={() => void launch()} (2651). A rejection from launchRun/cancelRun is discarded by void -> unhandled promise rejection, with no user feedback (button just un-busies). The kanban UI in the same file correctly does catch(e){notify(String(e))} (2041,2051), confirming the inconsistency. Low severity UX/error-handling gap.

### 173. [LOW · correctness] `apps/cli/src/workflow-pack.js:2878`

**jj log view parses multi-line jj output as one-commit-per-line, garbling commits and the count**

In the generated `vcs` workflow's `readLog`, the git branch uses `git log --oneline` (exactly one line per commit) but the jj branch runs `run('jj', ['log', '-n', '15', '--no-graph']).out` with NO one-line template. jj's default log template emits multiple lines per change (a metadata/header line plus description line(s) plus blank separators). The subsequent `nonEmptyLines(out).map(...)` treats every non-empty output line as a separate commit, so for jj you get far more 'commits' than changes, each with a garbled `id` (first whitespace-delimited token of whatever line it landed on) and wrong `subject`. The summary `commits.length + ' recent change(s)'` therefore overcounts. The History panel in vcs.tsx (`extractCommits`) renders this garbage for jj users. The git path is correct, so this is a jj-only correctness defect.

**Fix:** Give jj a one-line template, e.g. run('jj', ['log','-n','15','--no-graph','-T','change_id.short() ++ " " ++ description.first_line() ++ "\n"']).out so each output line maps to exactly one change, matching the git --oneline shape.

*Verifier:* Confirmed at lines 2877-2884. git path uses `git log --oneline` (one line/commit) but jj path uses `jj log -n 15 --no-graph` with NO single-line template; jj's default template emits multiple lines per change (header + description, plus separators). nonEmptyLines(out).map(...) treats each line as a separate commit, garbling id/subject and overcounting `commits.length`. jj-only correctness defect; the git path is correct.

### 174. [LOW · correctness] `apps/cli/src/workflow-pack.js:2896`  _(corroborated ×2)_

**git readDiff reports the unstaged file list for a staged patch**

In readDiff for git (lines 2894-2897) the patch is taken from `git diff --staged` first and only falls back to unstaged `git diff` when staged is empty, but the file list is unconditionally `nonEmptyLines(run('git', ['diff', '--name-only']).out)` — which is the UNSTAGED diff (working tree vs index), not `--staged`. In the normal commit scenario (everything staged), `git diff --name-only` returns empty, so the returned `files` is `[]` while `patch` is the full staged diff; with a mix of staged+unstaged changes, `files` lists only the unstaged files, never matching the staged patch. The `files` field of the diff output is therefore wrong precisely when committing staged work. (Impact is limited because the vcs UI only renders `patch`, not `files`, but the output contract is incorrect and these are user-editable seeded templates.)

**Fix:** Derive the name list from the same diff that produced the patch: capture whether the staged or unstaged diff was used and run `git diff --staged --name-only` accordingly, or compute files from the chosen `d.out`.

*Verifier:* Duplicate of finding 4, same lines 2894-2897. files is computed from unstaged `git diff --name-only` while patch prefers `git diff --staged`; with staged work the files list is [] or wrong relative to the patch. Real but low impact (UI renders only patch).

### 175. [LOW · logic] `apps/cli/src/workflow-pack.js:3561`

**grill-me passes ctx.input fields without null-coalescing, so declared defaults are silently dropped**

The generated `grill-me` workflow declares `maxIterations: z.number().int().default(30)` and `prompt: z.string().default("Describe what you want to get grilled on.")`, but renders `context={ctx.input.prompt}` and `maxIterations={ctx.input.maxIterations}` (lines 3558,3561) without `??` fallbacks. Per this codebase's own documented contract (see the comment the generator emits in the workflow-skill workflow at line 4198: "ctx.input fields arrive null (not their zod default) when unsupplied", confirmed by packages/driver/src/normalizeInputRow.js which never applies schema defaults), running `smithers workflow grill-me` with no input yields `ctx.input.prompt === null` and `ctx.input.maxIterations === null`. `GrillMe`'s `maxIterations = 1` default does not apply (the prop is null, not undefined), so buildPlanTree's `parseNum(node.props.maxIterations, 5)` clamps it to 5 iterations instead of the documented 30, and `{context}` renders to nothing so the grilling agent receives no topic context. The `mission` workflow in the same file correctly coalesces every input (`ctx.input.maxMilestones ?? 6`, etc.); grill-me, audit, and feature-enum do not, making the inconsistency clearly an oversight.

**Fix:** Coalesce input fields to their intended defaults at the render site, e.g. `context={ctx.input.prompt ?? "Describe what you want to get grilled on."}` and `maxIterations={ctx.input.maxIterations ?? 30}`, matching the defensive pattern used in the mission workflow.

*Verifier:* Confirmed at 3558/3561: grill-me passes context={ctx.input.prompt} and maxIterations={ctx.input.maxIterations} with no ?? fallback, while declaring defaults (30 / topic prompt) at 3544-3545. Per the documented null-on-omit contract (4198, normalizeInputRow), running grill-me with no input yields null, so the maxIterations default 30 is dropped (null != undefined so component/parseNum default applies instead) and {context} renders empty. The mission workflow coalesces every input (3939), confirming the oversight. Low severity (only the no-input path).

### 176. [LOW · crash] `apps/cli/src/workflows.js:316`

**Dangling symlink / unreadable .tsx crashes whole workflow discovery, defeating the per-file skip guard**

In discoverWorkflows the directory listing filters with `statSync` *outside* the per-file try/catch:

```
const files = readdirSync(dir)
  .filter((file) => file.endsWith(".tsx"))
  .filter((file) => statSync(join(dir, file)).isFile())  // can throw
  .sort();
```

The try/catch that the comment says guarantees "one malformed or unsupported workflow file must not hide every other valid workflow (or crash `workflow list` / the gateway's workspace registration)" only wraps `workflowFromFile` inside the loop. If any `*.tsx` entry is a dangling symlink, has been removed between readdir and stat (TOCTOU), or is unreadable (EACCES), `statSync` throws ENOENT/EACCES, which is uncaught here. That propagates out of discoverWorkflows and crashes every caller: `resolveWorkflow`, `writeWorkflowSkillFiles`, `smithers workflow list`, and the gateway's workspace registration. So a single bad directory entry defeats exactly the resilience guarantee the inner try/catch was written to provide.

**Fix:** Move the isFile() check into the per-file try/catch (or wrap the stat in its own try/catch that skips + warns on failure), e.g. compute the file list of names ending in .tsx, then inside the loop do `try { if (!statSync(join(dir,file)).isFile()) continue; entry = workflowFromFile(...); } catch (err) { warn + continue; }`.

*Verifier:* Lines 316-319: the filter chain calls statSync(join(dir,file)).isFile() OUTSIDE the per-file try/catch (which only wraps workflowFromFile at 330-336). statSync (not lstatSync) follows symlinks, so a .tsx dangling symlink throws ENOENT, a TOCTOU removal between readdir and stat throws ENOENT, and EACCES throws. Any propagates out of discoverWorkflows and crashes resolveWorkflow/workflow list/gateway registration, defeating the resilience promised in the comment at 324-328. Real, but trigger requires an unusual filesystem entry so severity is low not medium.

### 177. [LOW · correctness] `apps/cli/src/workflows.js:380`

**`createWorkflowFile` without `global` can silently create the workflow in the GLOBAL ~/.smithers pack and mislabel it as scope "local"**

`createWorkflowFile` resolves the target pack via `findLocalPackDir(from) ?? join(from, ".smithers")`, while hard-coding `const scope = options.global ? "global" : "local"`. `findLocalPackDir` walks all the way up to the filesystem root, so from a home-subdirectory that has no project-level `.smithers` (e.g. `~/notes`), it finds `~/.smithers` — which is the *global* pack (`globalPackDir()` === `accountsRoot()` === `~/.smithers`). The function then writes `~/.smithers/workflows/<name>.tsx` (a globally-visible workflow created by a user who asked for a local one) and returns a DiscoveredWorkflow with `scope: "local"` even though the file lives in the global pack. A subsequent `discoverWorkflows` will correctly classify the same file as `scope: "global"`, so the immediate return value is inconsistent with reality, and the new workflow leaks into every other directory's discovery. The docstring claims it falls back to `<from>/.smithers`, which is not what happens.

**Fix:** For the non-global path, restrict the local pack to one actually under `from` (or below the global root): if `findLocalPackDir(from)` resolves to the global pack dir, fall back to `join(from, ".smithers")` instead; and derive `scope` from whether the chosen packDir equals the global dir rather than from `options.global` alone.

*Verifier:* Lines 382-385 hard-code scope from options.global while packDir = findLocalPackDir(from) ?? join(from,'.smithers'). findLocalPackDir (43-56) walks to fsRoot and returns ANY .smithers found, including ~/.smithers == globalPackDir()/accountsRoot(). resolvePackDirs (74) explicitly guards resolve(local)!==globalAbs to collapse to global scope, but createWorkflowFile does NOT. So from a home-subdir with no closer pack it writes to ~/.smithers/workflows/<name>.tsx (globally visible) yet returns scope:'local', while later discoverWorkflows reclassifies it as 'global'. Genuine inconsistency/leak, edge case, low severity.

### 178. [LOW · crash] `apps/cli/src/workflows.js:518`

**writeWorkflowSkillFiles can mkdir over an existing file when output is an extensionless existing file path with multiple workflows**

When generating skills for multiple workflows, the guard only rejects an output with a non-empty extension: `if (workflows.length > 1 && output !== undefined && extname(outputPath) !== "")`. If the user passes `--output existing-file` where `existing-file` is an extensionless regular file, `outputLooksDirectory` is true only for directories, so it is false; the multi-workflow guard does not fire (extname is ""); `outputIsSingleFile` is false; and the loop computes `target = join(outputPath, assertSkillFileName(id))` then `mkdirSync(dirname(target) /* = the existing file */, { recursive: true })`, which throws ENOTDIR. The error is an opaque crash rather than the intended INVALID_INPUT guidance. Minor, but it is an unguarded edge that produces a confusing failure instead of the validation error the code clearly intends to surface.

**Fix:** Also treat an existing non-directory `outputPath` as a single-file/invalid target: when `existsSync(outputPath) && !isDirectory(outputPath)` and `workflows.length > 1`, throw the INVALID_INPUT "requires an output directory" error regardless of extension.

*Verifier:* Lines 515-518: for an extensionless existing regular file as --output with multiple workflows, outputLooksDirectory is false (not a dir, no trailing slash), outputIsSingleFile is false (length>1), and the guard requires extname(outputPath)!=='' which is '' so it does not fire. The loop then mkdirSync(dirname(target)=the existing file,{recursive:true}) which throws EEXIST/ENOTDIR instead of the intended INVALID_INPUT. Real but minor confusing-error edge.

### 179. [LOW · correctness] `apps/observability/src/_corePrometheus.js:90`

**renderPrometheusSamples lexicographically re-sorts histogram lines, scrambling bucket `le` order**

In `renderPrometheusSamples`, after building bucket lines in numeric boundary order (`buckets ... .sort(([left],[right]) => left - right)` at line 75), the family lines are re-sorted with a plain lexicographic `group.lines.sort()` at line 90. For a histogram the bucket lines look like `name_bucket{le="0.005"} ...`, `name_bucket{le="10"} ...`, `name_bucket{le="2.5"} ...`, `name_bucket{le="+Inf"} ...`. Lexicographic sort places `le="+Inf"` FIRST (the '+' char 0x2B sorts before digits) and orders finite boundaries as strings, so e.g. `le="10"` sorts before `le="2.5"` and `le="5"`. The emitted buckets are therefore non-monotonic and the cumulative `+Inf` total appears before the finite buckets. This contradicts the intent visible in the sibling renderer renderPrometheusMetrics.js (lines 82-85, 164-169) which preserves numeric bucket order and never applies a final lexicographic sort. Classic Prometheus text parsers tolerate unordered buckets, but OpenMetrics-strict scrapers / OTel Prometheus receivers expect ascending `le`, so this can corrupt histogram ingestion for stricter consumers. This path is what metricsServiceAdapter.renderPrometheus actually emits.

**Fix:** Do not lexicographically sort histogram bucket lines. Either build/keep per-family lines already ordered (buckets numeric ascending, then +Inf, then _sum, _count) and skip the `.sort()`, or sort only non-bucket families. Mirror renderPrometheusMetrics.js which pushes lines in the correct order without a trailing sort.

*Verifier:* Confirmed at line 90: `lines.push(...group.lines.sort())` applies a default lexicographic string sort to histogram lines that were deliberately built in numeric boundary order at lines 75-79 (`buckets ... .sort(([left],[right]) => left - right)`). For histogram lines like `name_bucket{le="0.005"}`, `name_bucket{le="10"}`, `name_bucket{le="2.5"}`, `name_bucket{le="+Inf"}`, lexicographic order puts `+Inf` first ('+' = 0x2B < digits 0x30) and orders finite boundaries as strings ("10" < "2.5"), producing non-monotonic `le`. The sibling renderer renderPrometheusMetrics.js confirms the intended behavior: line 202 does `lines.push(...metric.lines)` with NO sort, preserving numeric bucket order built at lines 164-169. The path is live: metricsServiceAdapter.js:186 calls renderPrometheusSamples in renderPrometheus. The defect is genuine but impact is low — standard Prometheus text parsers tolerate unordered buckets; only OpenMetrics-strict/OTel-receiver consumers require ascending le. Adjusted to low severity accordingly.

### 180. [LOW · performance] `apps/observability/src/_sessionFileResolvers.js:139`

**resolveCodexSessionFile reads each full session file into memory just to inspect the first line**

`const firstLine = (await readFile(file, "utf8")).split(/\r?\n/, 1)[0];` loads the ENTIRE jsonl file into memory and then keeps only the first line. Codex session files are full agent transcripts that can be tens or hundreds of MB. This runs for every candidate file across three day-folders (and for offsets -1/0/+1, both UTC and local), so a single resolution can read many large transcripts wholesale. On a busy machine this is a large, avoidable memory/IO spike and can noticeably stall the resolver.

**Fix:** Read only the first line, e.g. open the file and read a bounded chunk (createReadStream with a small highWaterMark, or read the first N KB) and parse up to the first newline, instead of `readFile` of the whole file.

*Verifier:* Line 139 is exactly as claimed: `const firstLine = (await readFile(file, "utf8")).split(/\r?\n/, 1)[0];`. readFile loads the entire file into memory; the split with limit 1 only trims the result array, the whole string is already materialized. The loop (lines 137-149) runs over candidates gathered from dayRoots (lines 133-134), which is buildCodexSessionRoots cross-product with up to 6 day folders (offsets -1/0/+1 in both UTC and local, lines 128-132), each folder enumerated recursively by listJsonlFiles. So a single resolution can read many full Codex transcript files wholesale just to inspect their first session_meta line. The factual description is accurate and only the first line is needed, so reading a bounded prefix would suffice. Severity is genuinely low/performance: it causes a transient memory/IO spike, not wrong behavior, a crash, data loss, or a persistent leak. Confidence medium because real-world impact depends on actual session-file sizes and how many candidates exist in practice.

### 181. [LOW · correctness] `apps/observability/src/metrics/smithersMetricCatalog.js:290`

**agentActionsTotal catalog labels do not match the labels actually emitted**

The catalog declares agentActionsTotal with `labels: ["action_name", "action_type", "engine", "source"]`. But the only emission site (trackEvent.js, the `AgentEvent`/`action` branch) tags agentActionsTotal with a completely different set: `action_kind`, `phase`, `level`, `entry_type`, `ok`, plus the base tags `engine` and `source`. The labels `action_name` and `action_type` are never produced, and the real high-cardinality dimensions (`action_kind`, `phase`, `level`, `entry_type`, `ok`) are undocumented. Any dashboard/alert generated from the catalog metadata would group by nonexistent labels and silently render empty, while the real series go undiscovered. The catalog is the documented contract for this metric (it is what `smithersMetricCatalogByName`/`byPrometheusName` and downstream tooling consume).

**Fix:** Update the agentActionsTotal entry's `labels` to the set actually emitted by trackEvent: ["action_kind", "phase", "level", "entry_type", "ok", "engine", "source"] (or fix the emission side to match if action_name/action_type is the intended schema).

*Verifier:* Confirmed. Catalog (smithersMetricCatalog.js:303-307) declares agentActionsTotal labels=[action_name, action_type, engine, source]. The only emitter (trackEvent.js:510-517, AgentEvent action branch) tags it with baseTags {engine, source} plus action_kind, phase, level, entry_type, ok. action_name/action_type are never produced; action_kind/phase/level/entry_type/ok are undocumented. The label set is objectively wrong/misleading. Impact is limited though: definition.labels is descriptive metadata only and is NOT consumed by renderPrometheusMetrics (it uses defaultLabels for seeding, never labels), so there is no runtime breakage in this repo, only an inaccurate exported contract for external tooling. Genuine low-severity correctness/documentation defect.

### 182. [LOW · correctness] `apps/observability/src/metrics/smithersMetricCatalog.js:494`

**~21 exported and emitted metrics are missing from smithersMetricCatalog**

index.js exports (and code emits) many metrics that are absent from `smithersMetricCatalog`: rewindTotal, rewindRollbackTotal, rewindDurationMs, rewindFramesDeleted, rewindSandboxesReverted (emitted in packages/time-travel/src/jumpToFrame.js), the devtools metrics (devtoolsActiveSubscribers, devtoolsSubscribeTotal, devtoolsEventTotal, devtoolsBackpressureDisconnectTotal, devtoolsDeltaBuildMs, devtoolsEventBytes, devtoolsSnapshotBuildMs), alertsResolvedTotal/alertsSilencedTotal/alertsReopenedTotal/alertsEscalatedTotal/alertDeliveriesAttempted/alertDeliveriesSuppressed, attentionBacklog, and gatewayRunEventBackpressureDisconnectTotal. Consequences: (1) renderPrometheusMetrics never emits `# HELP` lines or zero-seed series for these until first observed (the catalog loop is what seeds those); (2) `metricsServiceAdapter.resolveMetricDefinition` returns undefined for them, so if any of the histogram ones (e.g. devtoolsEventBytes=sizeBuckets, rewindFramesDeleted=custom buckets) were ever recorded via the generic adapter `histogram(name,...)` instead of directly, the fallback would register a same-named histogram with the wrong `durationBuckets`, producing conflicting Prometheus bucket definitions. Today these are recorded directly via Metric.update so the wrong-bucket path is not hit, limiting impact to missing HELP/seed metadata.

**Fix:** Add metricDefinition(...) entries for the missing rewind/devtools/alert/attention/gateway metrics (and regenerate the catalog if it is generated), so the catalog stays exhaustive and adapter lookups resolve them with correct buckets.

*Verifier:* Confirmed. All 20 named metrics (rewind*, devtools*, alerts resolved/silenced/reopened/escalated, alertDeliveries*, attentionBacklog, gatewayRunEventBackpressureDisconnectTotal) are exported from metrics/index.js (catalog=0, index=1 each) but absent from smithersMetricCatalog. They are genuinely emitted (e.g. rewindTotal/rewindFramesDeleted in packages/time-travel/src/jumpToFrame.js:1060,1067). renderPrometheusMetrics builds HELP lines and zero-seed series only from the catalog (defaultPrometheusMetricLines over the catalog), so these series get no HELP/seed until first observed. The wrong-bucket histogram fallback in metricsServiceAdapter.histogramMetric is real code but, as the claim itself concedes, is not hit today because these are recorded directly via Metric.update. Real but minor observability-completeness gap.

### 183. [LOW · error-handling] `apps/review/src/server/proxy/handleAnthropic.ts:143`

**Metering errors are silently swallowed, so a failing DB write lets the spend cap never advance**

The metering promise is wrapped in `})().catch(() => undefined);` (line 143) and handed to waitUntil. recordUsage is the only place `spent_usd` is incremented and the cap (handleAnthropic.ts:89 `if (spentUsd >= spendCapUsd)`) depends on that increment. If recordUsage consistently throws (DB unavailable, schema drift, INSERT constraint), every failure is swallowed with no log, so `spent_usd` never grows and the 402 brake never trips - a session can keep spending real Anthropic money unbounded while errors are invisible. The recordUsage.ts comment explicitly says the record must happen 'UNCONDITIONALLY' to enforce the cap, but the catch-all silently defeats that.

**Fix:** At minimum log the error inside the catch (console.error with context) so failures are observable; consider a fallback durable write or alerting when metering fails so the runaway brake degradation is detectable.

*Verifier:* Confirmed: the metering IIFE is wrapped in `.catch(() => undefined)` at line 143 with no logging before being passed to deps.waitUntil. recordUsage (recordUsage.ts) is the only code that increments spent_usd, and the cap at handleAnthropic.ts:89 depends on that increment. A sustained DB failure (db down, schema drift, INSERT constraint) is swallowed silently, so spent_usd never grows, the 402 brake never trips, and there is no error visibility. The recordUsage comment stresses recording must happen UNCONDITIONALLY to enforce the cap, which the silent catch-all undermines. Real defect, but lower severity: it requires persistent DB failure and the proxy is a code-review egress, so adjusted to low.

### 184. [LOW · resource-leak] `apps/review/src/server/walkthroughs/handleWalkthroughs.ts:36`

**25MB size limit enforced only after buffering the entire body into memory**

`const html = await request.arrayBuffer();` reads the FULL request body into memory, and only afterward does `if (html.byteLength > MAX_WALKTHROUGH_BYTES) return jsonError(413, ...)` reject it. The 25MB cap therefore provides no protection against memory exhaustion: a client can POST a body far larger than 25MB (up to the Cloudflare platform body cap, e.g. 100MB) and the worker fully buffers it before the check runs. Workers have a hard ~128MB memory limit, so buffering a ~100MB body (plus the subsequent R2 `put`) can OOM/crash the isolate. The size guard runs too late to do its job.

**Fix:** Pre-check the Content-Length header before reading: `const len = Number(request.headers.get('content-length')); if (len > MAX_WALKTHROUGH_BYTES) return jsonError(413, ...)`. For robustness against missing/spoofed Content-Length, read the body through a size-capped stream that aborts once MAX_WALKTHROUGH_BYTES is exceeded rather than calling arrayBuffer() unconditionally.

*Verifier:* Confirmed: line 36 `const html = await request.arrayBuffer();` fully buffers the request body into memory, and only afterward (line 38) does `if (html.byteLength > MAX_WALKTHROUGH_BYTES) return jsonError(413, ...)` run. The size guard therefore cannot prevent buffering an oversized body; a correct guard would check the Content-Length header before reading. The code genuinely exhibits the described pattern. Severity downgraded to low because the endpoint is gated behind auth (lines 31-35: legacy Bearer token or authenticateProxyRequest), so only an authenticated client can trigger it, and Cloudflare's own platform body cap bounds the worst case. Still, the cap does no memory-protection work as written, so the defect is real.

### 185. [LOW · error-handling] `apps/review/src/workflow/createReviewAgents.ts:32`

**Model env vars use ?? so an explicitly-empty SMITHERS_REVIEW_MODEL passes an empty model to the agent**

Line 32 `const model = process.env.SMITHERS_REVIEW_MODEL ?? "gpt-5.5";` and lines 54-55 (`SMITHERS_REVIEW_MODEL`/`SMITHERS_REVIEW_FALLBACK_MODEL`) use `??`, which only falls back on null/undefined. If the variable is exported but empty (`SMITHERS_REVIEW_MODEL=`), `model` becomes `""`, which is then passed to CodexAgent/ClaudeCodeAgent and forwarded as `--model ` (empty), failing the run instead of using the documented default. This is inconsistent with the engine check on line 29 which uses `?.trim().toLowerCase()` and treats empty as unset. CI/cloud env that sets the var to empty would break.

**Fix:** Normalize first, e.g. `const model = process.env.SMITHERS_REVIEW_MODEL?.trim() || "gpt-5.5";` (and likewise for the claude primary/fallback models) so empty strings fall through to the default.

*Verifier:* Confirmed in code. createReviewAgents.ts:32/54/55 use `??`, which only coalesces null/undefined, so an exported-but-empty SMITHERS_REVIEW_MODEL yields model="". The empty string is passed to CodexAgent/ClaudeCodeAgent, whose run code (CodexAgent.js:532, ClaudeCodeAgent.js:417) does `pushFlag(args, "--model", this.opts.model ?? this.model)`. pushFlag (BaseCliAgent/pushFlag.js) only returns early when value===undefined; an empty string falls to the else branch and pushes `--model ""`, so the CLI receives an empty model flag instead of the default, breaking the run. This is genuinely inconsistent with line 29's `?.trim().toLowerCase()` which treats empty as unset. Real defect, but only triggers when an env var is explicitly set to empty (an edge case, hence low severity).

### 186. [LOW · data-loss] `packages/accounts/src/parseAccountsFile.js:80`

**Unknown-provider accounts are silently and permanently dropped on the next write**

`parseAccountsFile` skips entries with an unrecognized provider on read (lines 80-83). Because `addAccount`/`removeAccount` do a read-modify-write (`readAccounts()` then `writeAccounts({ version: 1, accounts: next })`), the skipped legacy entries are not part of `existing.accounts` and are therefore erased from disk the next time ANY account is added or removed. So a single unrelated `addAccount(...)` call permanently deletes a user's legacy entry (e.g. a leftover `gemini` account) from accounts.json, not just hides it for that read. While skipping on read is documented, the silent destructive rewrite is a surprising side effect of an unrelated mutation and is unrecoverable once the file is rewritten.

**Fix:** Either preserve unknown entries through the read-modify-write (carry skipped raw entries forward in writeAccounts), or at minimum emit a one-time explicit warning that the legacy entry will be removed on the next write so the loss is not silent.

*Verifier:* Mechanism confirmed in actual code. parseAccountsFile lines 80-83 do `continue` on unrecognized providers, excluding them from the returned accounts array. readAccounts.js:19 returns parseAccountsFile(raw) directly. addAccount.js:40,54-57 build `next` from the filtered existing.accounts and call writeAccounts({version:1, accounts: next}) which rewrites the whole file; removeAccount.js:19-25 does the same. Therefore any single unrelated addAccount/removeAccount permanently deletes a skipped legacy (e.g. gemini) entry from accounts.json, losing its stored apiKey/configDir. The doc comment documents skip-on-read but not this destructive whole-file rewrite. Real, low severity: the dropped entry was already inert (skipped) so no live account breaks, but the user's stored legacy credentials are silently and unrecoverably erased by an unrelated mutation.

### 187. [LOW · error-handling] `packages/agents/src/BaseCliAgent/BaseCliAgent.js:972`

**Non-zero termination via null exitCode (external signal kill) is treated as success**

`if (result.exitCode && result.exitCode !== 0)` only enters the error branch when exitCode is a truthy non-zero number. When the child process is terminated by an external signal not initiated by our own kill() path, `spawnCaptureEffect` finalizes with `exitCode: code ?? null` (child-process.js:202), so `result.exitCode` is null. The `&&` short-circuits on null, so the run is treated as a successful completion and whatever partial stdout was captured is returned as the agent's answer (subject only to the later `completedEvent?.ok === false` check, which is null when the harness never emitted a completed event). A signal-killed agent therefore produces a bogus 'successful' result instead of an error. Our own timeout/idle/abort kills settle with Effect.fail before `close` fires, so this only affects external-signal kills, making it an edge case.

**Fix:** Treat a null exitCode (with no successful completed event) as a failure, e.g. `if (result.exitCode !== 0) { ... }` after normalizing null, or explicitly fail when `result.exitCode == null && completedEvent?.ok !== true`.

*Verifier:* Confirmed. packages/driver/src/child-process.js: child.on('close', (code) => finalize({...exitCode: code ?? null...})). Node delivers code=null when a process is terminated by a signal, so result.exitCode is null. Our own timeout/idle/abort kills settle first via the kill() helper which sets settled=true and resume(Effect.fail(...)) BEFORE close fires, and finalize bails on `if (settled) return`, so those paths are unaffected. For an EXTERNAL signal kill (no timer/abort), settled is still false, finalize runs with exitCode:null and resume(Effect.succeed). Back in BaseCliAgent line 972, `if (result.exitCode && result.exitCode !== 0)` short-circuits on null, skipping the error branch; the subsequent completedEvent?.ok===false check is null/skipped when no completed event was emitted. The signal-killed run is therefore treated as success and partial captured stdout is returned. Genuine but narrow edge case (external signal), so low severity.

### 188. [LOW · correctness] `packages/agents/src/capability-registry/hashCapabilityRegistry.js:24`

**Stable hash uses locale-dependent String.localeCompare for key ordering**

`toStableJson` sorts object keys with `.sort(([left],[right]) => left.localeCompare(right))` (line 24), and `normalizeCapabilityRegistry`/`normalizeCapabilityStringList` likewise sort tool names, methods, builtIns and skill ids with `localeCompare`. `String.prototype.localeCompare` invoked with no locale argument uses the host's default locale (driven by env such as LANG/LC_COLLATE/ICU build). The output of `hashCapabilityRegistry` is treated as a persistent, deterministic fingerprint: it is folded into the engine step-cache key (`toolsSig = hashCapabilityRegistry(...)` in packages/engine/src/engine.js:2989 and :4315) and surfaced as the `fingerprint` in `getCliAgentCapabilityReport`. Because the sort order is locale-defined rather than code-point defined, the same logical registry can serialize key/list order differently on two machines (or two processes) whose default collation differs, yielding different SHA-256 fingerprints for identical capabilities. That produces spurious step-cache misses (and a misleading 'capabilities changed' signal) when a workspace/DB is shared or moved across environments with different locales. In this codebase all sorted strings happen to be ASCII identifiers, so divergence is unlikely in practice, which is why confidence/severity are low; the correct primitive for a deterministic hash is a plain code-point comparison.

**Fix:** Sort by code point for deterministic, locale-independent ordering, e.g. `(left, right) => (left < right ? -1 : left > right ? 1 : 0)`, in toStableJson, normalizeCapabilityRegistry, and normalizeCapabilityStringList.

*Verifier:* Code confirmed: toStableJson sorts object keys with `left.localeCompare(right)` (hashCapabilityRegistry.js:24), normalizeCapabilityRegistry.js:25 sorts runtimeTools keys the same way, and normalizeCapabilityStringList.js:8 sorts methods/builtIns/skillIds with localeCompare. The SHA-256 output is genuinely persisted as part of the step-cache key (engine.js:2989/3024/3040/4315 set `toolsSig` inside cacheBase). localeCompare invoked without a locale uses the host default collation (LANG/LC_COLLATE/ICU build), which is not guaranteed identical across machines/processes — the wrong primitive for a deterministic fingerprint; a code-point comparison would be correct. The defect is real but low impact: the sorted values are ASCII identifiers (tool names like 'Bash', 'Read', MCP names like 'mcp__smithers__ask_human') whose ordering is stable across virtually all common locales/ICU configs, so divergent hashes are unlikely in practice. Confidence is low precisely because manifesting wrong behavior requires names where locale tailoring differs (e.g. punctuation/case variable-weighting), which is plausible but not demonstrated in current data. Severity low matches the claim's own assessment.

### 189. [LOW · crash] `packages/agents/src/diagnostics/getDiagnosticStrategy.js:32`

**checkCliInstalled spawnSync("which") has no timeout and defeats runDiagnostics' 5s per-check guard**

runDiagnostics.runCheck wraps every check in a 5s timeout via Promise.race + setTimeout (PER_CHECK_TIMEOUT_MS = 5_000, runDiagnostics.js:14-31). That guard is implemented as an event-loop timer. The cli_installed check runs `const result = spawnSync("which", [command], { stdio: [...] })` (getDiagnosticStrategy.js:32) synchronously and with NO `timeout` option (unlike the other spawnSync calls in this file, e.g. claude auth status uses `timeout: 3_000` and gcloud uses `timeout: 3_000`). Because spawnSync blocks the thread, the 5s race timer cannot fire while it runs (the event loop is blocked), and the timer for this check is only registered AFTER the synchronous portion completes anyway. So if `which`/the spawned process ever hangs (e.g. a pathological PATH/FS, a fuse mount, an antivirus shim), the entire diagnostics run hangs indefinitely with no timeout protection, even though the code's whole point is to bound each check at 5s. The other checks bound themselves with their own spawnSync/fetch timeouts; this one does not.

**Fix:** Add `timeout: 3_000` (and ideally `killSignal: "SIGKILL"`) to the spawnSync options in checkCliInstalled, matching the other spawnSync calls, so a hung `which` cannot block the whole diagnostics run.

*Verifier:* Confirmed at line 32: spawnSync("which", [command], {stdio:[...]}) has NO timeout option, unlike sibling spawnSync calls (claude auth status timeout:3_000 line 77, gcloud timeout:3_000 line 546). runDiagnostics.runCheck wraps checks in Promise.race with a setTimeout(5s) guard (runDiagnostics.js:25-31), but checkCliInstalled.run has no await before spawnSync, so calling check.run(ctx) executes the synchronous spawnSync fully and returns an already-resolved promise BEFORE the timeout array element's executor (which registers setTimeout) is even evaluated. Even if it were registered first, spawnSync blocks the single JS thread so the timer callback cannot fire. Therefore the 5s per-check guard provides zero protection for this check; a hanging `which` (pathological PATH/FS/fuse/AV shim) hangs the entire diagnostics run indefinitely. Genuine robustness/hang defect; low severity because the hang trigger is uncommon.

### 190. [LOW · correctness] `packages/agents/src/http/createHttpTool.js:98`

**Basic auth via btoa() throws on non-ASCII credentials and mis-encodes UTF-8**

applyAuth builds the Basic header with `btoa(`${auth.username}:${auth.password}`)` (line 98). btoa only accepts Latin1 (code points 0-255); any username or password containing a character above U+00FF (e.g. a unicode password, an email-less token with emoji, or accented letters) throws `InvalidCharacterError: The string to be encoded contains characters outside of the Latin1 range`, which rejects the tool call. Even for characters in 0x80-0xFF, btoa encodes the raw code unit rather than the UTF-8 bytes, producing a header that the server decodes incorrectly per RFC 7617 (which mandates UTF-8). So Basic auth with non-ASCII credentials either crashes or authenticates with corrupted bytes.

**Fix:** Encode UTF-8 bytes before base64, e.g. `btoa(String.fromCharCode(...new TextEncoder().encode(`${auth.username}:${auth.password}`)))` or use Buffer.from(`${u}:${p}`,'utf8').toString('base64') in the Node/Bun runtime.

*Verifier:* Line 98 builds Basic auth via btoa(`${auth.username}:${auth.password}`). btoa only accepts Latin1; any credential char above U+00FF throws InvalidCharacterError, which rejects the tool call (no surrounding catch). For chars in 0x80-0xFF it encodes the raw code unit, not the UTF-8 bytes RFC 7617 requires, so the server decodes corrupted credentials. Confirmed exact code; low severity since plain-ASCII credentials (the common case) work.

### 191. [LOW · logic] `packages/agents/src/image-generation/createImageGenerationTool.js:90`

**Empty-string model from agent input suppresses the configured default model**

In normalizeImageGenerationInput the model fallback is `...(typeof value.model === "string" ? { model: value.model } : options.model ? { model: options.model } : {})`. The check is `typeof value.model === "string"`, which is true for an empty string. If the agent passes `model: ""` (the JSON schema declares `model` as a plain string with no minLength), the branch sets `model: ""` and never falls through to the configured `options.model` default. The provider then receives an empty model id instead of the intended default, likely causing a provider error or wrong-model selection. Other fields (size/style) have the same empty-string-passes-through pattern, but model is the one with an intended default that gets clobbered.

**Fix:** Treat empty/blank strings as absent for the model override, e.g. `const m = typeof value.model === "string" && value.model.trim() !== "" ? value.model : options.model; ...(m ? { model: m } : {})`.

*Verifier:* Confirmed in the real code. Line 90: `...(typeof value.model === "string" ? { model: value.model } : options.model ? { model: options.model } : {})`. `typeof "" === "string"` is true, so an empty-string model from the agent takes the first branch and produces `model: ""`, never falling through to the configured `options.model` default. The JSON schema (lines 20-23) declares `model` as a plain string with NO minLength, so `model: ""` is a schema-valid agent input. Contrast with `prompt`, which has both `minLength: 1` (line 18) and an explicit `.trim() === ""` guard (line 81); model has neither. ImageGenerationToolOptions.model is documented as the default 'when the agent does not specify one', confirming the intent that empty input should fall back to it. So the defect genuinely exists and would send an empty model id to the provider. Severity is low because agents seldom emit empty-string optional fields, but the code-level defect is real.

### 192. [LOW · error-handling] `packages/agents/src/KimiAgent.js:37`

**A single unreadable/corrupt .json in the credentials dir forces a non-retryable config error**

`refreshKimiTokenIfNeeded` returns `{ ok: false, reason: "unreadable", expiredAt: null }` for any `.json` file it cannot `JSON.parse` (lines 33-38). In `ensureKimiCredentialsUsable`, if that is the only `.json` file present, `anyUsable` stays false and the function throws a non-retryable `AGENT_CONFIG_INVALID` with the misleading message "OAuth token expired at null; auto-refresh failed: unreadable" (lines 174-186). A momentarily-being-written or non-credential json file thus permanently blocks the run with a wrong "token expired" message even though kimi itself may authenticate fine. An unreadable file is not the same as an expired token and should not be reported as one (note `expiredAt: null` producing "expired at null").

**Fix:** Treat an unparseable file as inconclusive rather than a fatal expired-credential failure: skip it (don't count it as a failure) or surface a distinct, retryable diagnostic instead of throwing non-retryable AGENT_CONFIG_INVALID with an "expired at null" message.

*Verifier:* Confirmed at code level. A .json file that fails JSON.parse returns {ok:false, reason:'unreadable', expiredAt:null} (lines 36-38). In ensureKimiCredentialsUsable the loop sets lastFailure for non-ok results (line 171); if it's the only .json, anyUsable stays false and it throws AGENT_CONFIG_INVALID with message `OAuth token expired at null; auto-refresh failed: unreadable` (lines 174-186, the non-'no-refresh-token' branch) and failureRetryable:false. The 'expired at null' message is objectively wrong (the file was never parsed, so no expiry was read) and the error is non-retryable. Note the module's own atomic writes use a `.tmp-` suffix (line 121) so they won't match the .json filter, making the self-induced torn-file case unreachable; the realistic trigger is a genuinely corrupt/non-credential .json or a kimi-cli mid-write file. Lowered to low: the misleading message is the concrete confirmable defect; the transient-blocking scenario is plausible but narrow.

### 193. [LOW · resource-leak] `packages/agents/src/KimiAgent.js:93`

**OAuth refresh fetch has no timeout/abort and runs synchronously before spawn**

`refreshKimiTokenIfNeeded` does `const resp = await fetch(tokenUrl, { method: "POST", headers, body })` (lines 93-97) with no `signal`/timeout. This runs inside `buildCommand` via `await ensureKimiCredentialsUsable(...)` (line 355), before the kimi process is ever spawned. If `auth.kimi.com` (or a `KIMI_OAUTH_HOST` override) hangs (slow/unresponsive endpoint, half-open connection), the agent invocation wedges indefinitely with no way to time out, and because results are deduped via `inflightRefreshes`, every concurrent Kimi task on the same credential file blocks on the same hung promise.

**Fix:** Pass an `AbortSignal` with a bounded timeout (e.g. `AbortSignal.timeout(15000)`) to the refresh `fetch`, and treat the resulting abort as a transient (retryable) failure.

*Verifier:* Confirmed. The fetch at lines 93-97 passes no `signal`/AbortController and there is no timeout wrapper; Bun/Node fetch has no default request timeout, so a hung/half-open auth.kimi.com (or KIMI_OAUTH_HOST override) endpoint blocks indefinitely. This runs synchronously inside buildCommand via `await ensureKimiCredentialsUsable(...)` at line 355, before the kimi process is spawned, so the whole agent invocation wedges. The inflightRefreshes dedup map (lines 54-58, 125) means concurrent Kimi tasks on the same credential file await the same hung promise. Real, though impact is bounded (requires a hanging endpoint) so low severity.

### 194. [LOW · error-handling] `packages/agents/src/OpenCodeAgent.js:348`

**Error name is dropped when error.data exists but has no message, losing diagnostics and breaking quota/non-retryable classification**

In the error-event branch:

```js
const errorObj = isRecord(payload.error) ? payload.error : null;
const errorData = errorObj && isRecord(errorObj.data) ? errorObj.data : null;
const errorName = errorObj ? asString(errorObj.name) : null;
const errorMessage = errorData
  ? asString(errorData.message)
  : errorName ?? "OpenCode reported an error";
```

The ternary keys off whether `errorData` is a record, NOT whether it actually contains a usable message. OpenCode's NamedError shape is `{ name, data }`, and `data` is frequently a populated object that does not include a `message` field (e.g. `{ error: { name: "ProviderAuthError", data: {} } }` or a data blob with structured fields but no `message`). In that case `errorData` is truthy, so the expression evaluates `asString(errorData.message)` -> `undefined`, and the `errorName ?? "OpenCode reported an error"` fallback is UNREACHABLE. `terminalError`/the completed event's `error` then become the generic "OpenCode reported an error" instead of e.g. "ProviderAuthError".

Impact: (1) the actual error name (RateLimitError, ProviderAuthError, etc.) is lost from logs/UI; (2) more importantly, downstream `classifyQuota(completedError, ...)` and non-retryable classification (BaseCliAgent.js ~1012-1018) run on the generic string, so a quota/auth error whose only signal is the error *name* is misclassified as a plain retryable AGENT_CLI_ERROR and gets retried instead of switching providers / failing fast.

**Fix:** Prefer message but always fall back to name regardless of whether data is a record: `const errorMessage = asString(errorData?.message) ?? errorName ?? "OpenCode reported an error";` (optionally combine name + message when both exist).

*Verifier:* Mechanical claim confirmed in OpenCodeAgent.js:346-350. asString (parseHelpers.js:14-16) returns undefined for a missing field. The ternary branches on whether errorData is a record, not on whether it contains a message, so when errorObj.data is a record lacking a `message` field, errorMessage=undefined and the `errorName ?? "..."` branch is unreachable; terminalError and the completed event's error fall back to the generic string and errorObj.name is dropped. The intended fallback chain (data.message -> name -> generic) is genuinely broken, causing diagnostic loss. HOWEVER the claimed quota/non-retryable misclassification impact is overstated: QUOTA_PATTERNS (BaseCliAgent.js:9-17) match content phrases ("rate limit exceeded", "too many requests", "429 ... try again"), and classifyNonRetryableAgentError patterns (764-773) match "LLM not set", "401 ... invalid authentication", etc. Bare error names like "ProviderAuthError"/"RateLimitError" do not match any of these even if preserved, so retry/quota classification would be unaffected. Real defect, but low severity (diagnostic message quality), not the medium-severity classification break described.

### 195. [LOW · correctness] `packages/agents/src/PiAgent.js:134`

**Empty `models`/`listModels` values push empty CLI args to pi**

In buildArgs, `if (this.opts.models) { const models = Array.isArray(...) ? join(',') : models; args.push('--models', models); }` treats an empty array as truthy. Passing `models: []` (a valid `string|string[]`) yields `args.push('--models', '')`, sending a bare empty `--models ''` to the pi CLI. The same pattern applies to `listModels`: `if (this.opts.listModels !== undefined && this.opts.listModels !== false)` passes for `listModels: ''`, then `typeof === 'string'` pushes `--list-models ''`. Unlike the other array options (extension/skill/tools), which are guarded by `?.length` or only loop over entries, these inject an empty-string argument that the CLI will treat as an invalid/empty value rather than as 'no flag'.

**Fix:** Guard on non-empty: e.g. `const models = Array.isArray(this.opts.models) ? this.opts.models.join(',') : this.opts.models; if (models) args.push('--models', models);` and for listModels only push the string form when it is a non-empty string.

*Verifier:* Confirmed against the real code (lines 134-147) and types (PiAgentOptions.ts: models?: string | string[]; listModels?: boolean | string). For models: [] (type-valid), `if ([])` is truthy, Array.isArray([]) true, [].join(',') === '', so args.push('--models', '') injects a bare empty arg. For listModels: '' (type-valid), '' !== undefined && '' !== false passes and typeof '' === 'string' pushes ('--list-models', ''). This is inconsistent with sibling options: tools is guarded by ?.length (149) and extension/skill/promptTemplate/theme loop over entries (154-179) so an empty array yields no args. The defect matches the claim; impact is low because it needs an unusual but type-valid input and the actual harm depends on pi's handling of an empty flag value (unverified).

### 196. [LOW · error-handling] `packages/agents/src/web-search/createGroundedWebSearchToolset.js:54`

**All provider failures are silently swallowed, returning empty results indistinguishable from "no hits"**

searchAll uses `Promise.allSettled` and then `for (const outcome of settled) { if (outcome.status !== "fulfilled") continue; ... }`. Rejected provider searches (invalid API key, network error, non-JSON body causing JSON.parse to throw inside readJson, 4xx/5xx that make readJson throw) are dropped with no logging and no error propagation. If every provider fails, execute returns `{ query, providers: [], results: [] }`. The calling LLM agent cannot distinguish "the web genuinely returned nothing" from "all search infrastructure is broken / misconfigured", which for a grounded-citation tool leads to silent wrong behavior (e.g. the agent concluding no information exists, or hallucinating). At minimum the all-failed case (succeededProviders empty while at least one provider was attempted) should surface the underlying errors rather than masquerade as an empty result set.

**Fix:** Collect rejected reasons into an `errors` field on the return object, and/or throw if `succeededProviders.length === 0` while providers were attempted, e.g. `if (succeededProviders.length === 0 && providers.length) throw new Error('grounded_web_search: all providers failed: ' + reasons.join('; '))`.

*Verifier:* Confirmed at lines 49-68: searchAll uses Promise.allSettled then `if (outcome.status !== "fulfilled") continue;` with no logging, no rethrow, no error capture. Rejected provider searches (bad key, network error, non-JSON parse throw, 4xx/5xx) are dropped. If every provider rejects, succeededProviders stays [] and results stays [], so execute returns `{query, providers: [], results: []}` (lines 69-73). The errors are genuinely swallowed and an all-failed run is returned as an empty success. Severity lowered to low because the return DOES carry a partial distinguishing signal: `providers: []` (empty succeeded-provider list) when everything failed vs a non-empty list when providers ran but found nothing, so it is not strictly 'indistinguishable' as claimed, and there is no crash/leak/data loss — it is an error-surfacing weakness, not a hard fault.

### 197. [LOW · api-misuse] `packages/agents/src/web-search/createGroundedWebSearchToolset.js:87`

**maxResults input is hard-capped to maxResultsPerProvider, making the advertised up-to-20 parameter ineffective**

The tool's inputSchema advertises `maxResults: { type: "number", minimum: 1, maximum: 20 }`, but normalizeInput does `const cappedMax = Math.min(requestedMax, defaultMaxResults);` where defaultMaxResults is `options.maxResultsPerProvider ?? 5`. This means any agent-supplied maxResults greater than the configured per-provider cap (default 5) is silently clamped down to 5 — the maximum:20 in the schema is never reachable, and the maxResults parameter can only ever reduce results below 5, never increase them. An agent that requests 20 results expecting 20 gets 5 with no indication, a contract mismatch between the documented schema and actual behavior.

**Fix:** Clamp only against the schema maximum (20), not against the per-provider default: `const requestedMax = typeof value.maxResults === 'number' ? value.maxResults : defaultMaxResults; return { maxResults: Math.min(Math.max(Math.trunc(requestedMax), 1), 20), ... }` — or align the schema's maximum with maxResultsPerProvider so the advertised bound matches reality.

*Verifier:* Confirmed. inputSchema advertises maxResults maximum:20 (line 29). normalizeInput (lines 86-90): requestedMax = supplied number or defaultMaxResults; cappedMax = Math.min(requestedMax, defaultMaxResults) where defaultMaxResults = options.maxResultsPerProvider ?? 5 (passed from line 34). So any agent-supplied maxResults above the configured per-provider cap (default 5) is clamped down to that cap; the final Math.min(..., 20) on line 90 is dead because cappedMax is already <= defaultMaxResults. The schema's maximum:20 is unreachable unless maxResultsPerProvider is configured >= the request, and maxResults can only ever lower results, never raise them. Real schema/behavior contract mismatch. Severity low: it under-returns results, never crashes, and may be an intentional ceiling, but the advertised 20 is misleading.

### 198. [LOW · logic] `packages/components/src/components/ScanFixVerify.js:16`

**ScanFixVerify silently ignores all but the first fixer when an array is passed**

`const fixers = Array.isArray(props.fixer) ? props.fixer : [props.fixer];` then the single fix Task uses `agent: fixers[0]` (line 32). The prop is documented as "When an array is provided, agents are cycled across issues", but every fixer after index 0 is dropped — no cycling occurs. A caller supplying multiple fixers gets only the first applied, with no error or warning, so the configured parallelism/agent diversity is silently lost.

**Fix:** Either remove the array support from the type/docs, or actually fan out: create one fix Task per fixer (or per discovered issue) inside the Parallel and assign `fixers[i % fixers.length]` to each.

*Verifier:* Line 16 computes `fixers = Array.isArray(props.fixer) ? props.fixer : [props.fixer]` but the fix Task at line 31 uses only `agent: fixers[0]`. ScanFixVerifyProps.ts line 10 documents 'When an array is provided, agents are cycled across issues.' No cycling occurs; every fixer after index 0 is silently dropped with no error or warning. Confirmed contract violation.

### 199. [LOW · logic] `packages/components/src/components/Worktree.js:10`

**Worktree throws on empty path even when skipIf is set, instead of skipping**

The empty-path validation (lines 10-12) runs before the `skipIf` check (line 13). A skipped worktree with an empty/blank path (`<Worktree skipIf path="">`) throws `WORKTREE_EMPTY_PATH` instead of returning null. Every other component in this slice (Timer, WaitForEvent, Supervisor, SuperSmithers, TryCatchFinally, Loop) evaluates `skipIf` first, so this ordering is inconsistent and causes an unexpected crash for a node the author intended to skip.

**Fix:** Move `if (props.skipIf) return null;` above the path validation so a skipped worktree never validates its path.

*Verifier:* Worktree.js lines 10-12 throw SmithersError('WORKTREE_EMPTY_PATH') when path is not a non-blank string, and this runs BEFORE the skipIf check at line 13-14 which returns null. So `<Worktree skipIf path="">` throws instead of skipping. Sibling components order skipIf first: Timer.js checks `if (props.skipIf) return null` at line 9 before its INVALID_INPUT throws at lines 14/17; WaitForEvent (line 8), Supervisor (line 18), TryCatchFinally (line 19), SuperSmithers (line 34) all check skipIf first too. The ordering in Worktree is genuinely inconsistent and causes an unexpected throw for a node intended to be skipped. Real defect, but low impact since it requires the unusual combination of skipIf with an empty path.

### 200. [LOW · data-loss] `packages/control-plane/src/index.js:599`

**Entity creation and its audit-event write are not atomic; a failure/crash between them leaves an entity with no audit record**

Every mutating method does the primary write under SQLite autocommit and THEN calls recordAuditEvent as a separate, independent set of statements (createOrg lines 588-606, createTeam 634-651, createProject 697-715, upsertBillingAccount/upsertIdentityProvider/setUsageLimit/putSecretRef/recordUsage). None wrap the primary write + audit insert in this.sqlite.transaction(...). If recordAuditEvent throws (its own requiredId/jsonObject validation, or a crash between the two statements) the entity row is already committed but its audit event is missing, and the method throws so the caller believes the op failed (and a retry of createOrg/createTeam then hits DUPLICATE_ID on the slug). For an audit/compliance control plane whose exportOrgAudit is the product, entity-present-but-audit-missing is a real integrity gap.

**Fix:** Wrap the primary INSERT and the corresponding recordAuditEvent call in a single this.sqlite.transaction(() => { ... })() so they commit or roll back together.

*Verifier:* Confirmed: every mutating method runs its primary INSERT under SQLite autocommit and then calls recordAuditEvent as a separate, independent set of statements with no this.sqlite.transaction(...) wrapper (createOrg 588-606, createTeam 634-651, createProject 697-715, setUsageLimit 937-953, putSecretRef 1033-1063, etc.). recordAuditEvent validates its inputs at the TOP (lines 1102-1108) before its own INSERT, so if it throws the primary row is already committed but no audit row exists, and the method propagates the throw so the caller believes the op failed (a retried createOrg/createTeam then hits DUPLICATE_ID on the slug). This is concretely reachable without a crash via finding [3] (a dotted secret name). For the create* methods specifically recordAuditEvent rarely throws (ids are pre-validated), so that part needs a process crash mid-method, which is plausible for a durable/compliance control plane. Genuine integrity gap, but real-world non-crash impact is mostly the [3] case; severity lowered.

### 201. [LOW · security] `packages/db/src/adapter.js:261`

**Read-only raw-query guard allows Postgres `SELECT ... INTO`, which creates/writes a table**

`validateReadOnlyRawQuery` enforces read-only by (a) rejecting the forbidden keywords `RAW_QUERY_FORBIDDEN_KEYWORDS = /\b(?:drop|delete|insert|update|alter|create|attach|detach|pragma)\b/i` and (b) requiring the statement to start with `RAW_QUERY_ALLOWED_PREFIX = /^(?:select|with|explain|values)\b/i`. On Postgres (the adapter supports `dialect === POSTGRES`), `SELECT ... INTO newtable FROM ...` is a DDL/write that materializes a new table. It begins with `select` (passes the prefix check) and contains none of the forbidden keywords (no `create`), so it passes validation and is executed verbatim via `internalStorage.queryAllRaw`. This defeats the read-only boundary the guard exists to enforce — an attacker (or buggy caller) reaching `rawQuery` on a Postgres-backed store can create arbitrary tables (and `SELECT INTO ... FROM (DELETE ...)`-style CTE tricks are likewise only partially covered). The same gap means the guard is weaker than its contract claims for any future caller that does pass untrusted SQL.

**Fix:** Add `into` (and consider `merge`, `truncate`, `grant`, `revoke`, `copy`, `vacuum`, `reindex`, `replace`) to the forbidden-keyword regex, or specifically reject `\bselect\b[\s\S]*\binto\b` for the Postgres dialect, so `SELECT ... INTO` is blocked.

*Verifier:* Confirmed. validateReadOnlyRawQuery (L229-268) only rejects RAW_QUERY_FORBIDDEN_KEYWORDS=/drop|delete|insert|update|alter|create|attach|detach|pragma/ and requires prefix select|with|explain|values. `SELECT a INTO newtab FROM src` matches neither a forbidden keyword nor lacks the allowed prefix. I reproduced both facts: against PGlite `SELECT ... INTO newtab` creates a real table, and a JS run of the two regexes shows forbidden-match=null and prefix-ok=true. So the read-only guard is bypassable on the Postgres path (rawQuery L662-663 executes it via queryAllRaw). It is a genuine weakness vs the guard's stated contract. Severity lowered to low: rawQuery has no untrusted external caller today (only packages/scorers/src/aggregate.js with internal SQL), so it is defense-in-depth weakening, not an exploitable path.

### 202. [LOW · correctness] `packages/db/src/adapter.js:1776`

**Alert metrics double-applied on transaction commit-retry (alertsActive gauge drift)**

`insertAlert` (1770-1781), `acknowledgeAlert` (1835-1849) and `resolveAlert` (1858-1874) run their `Metric.increment`/`Metric.update` calls INSIDE the `operation` Effect passed to `withTransaction`. `withTransactionEffect` wraps the whole thing in `withSqliteWriteRetryEffect` (line 795) and runs `operation` to completion BEFORE issuing COMMIT (line 847-862). If COMMIT fails with a retryable (e.g. SQLITE_BUSY) error, the entire effect — including the already-executed `Metric.increment(alertsFiredTotal)` / `Metric.update(alertsActive, 1)` — is re-run, but the prior attempt's metric mutations are not rolled back. So a commit-retry double-counts `alertsFiredTotal`/`alertsAcknowledgedTotal` and permanently drifts the `alertsActive` gauge (each retry adds an extra +1 in insertAlert or an extra -1 in resolveAlert). The DB row itself stays correct; only the observability metrics become unreliable.

**Fix:** Move the Metric updates out of the retried transaction body — apply them once after `withTransaction` resolves successfully (based on the committed before/after status), so retries cannot re-apply them.

*Verifier:* Confirmed. insertAlert (L1770-1781), acknowledgeAlert (L1835-1849), resolveAlert (L1858-1874) run Metric.increment/Metric.update INSIDE the operation passed to withTransaction. withTransactionEffect wraps everything in withSqliteWriteRetryEffect, which is `Effect.suspend(operation).pipe(Effect.retry(...))` (withSqliteWriteRetryEffect.js L107) — the whole effect, including the metric mutations, re-runs on a retryable error. COMMIT can raise SQLITE_BUSY (retryable per isRetryableSqliteWriteError), and on retry getAlert finds no row (the failed COMMIT rolled back), so the insert + metric increments execute again. DB row stays correct (insertIgnore is idempotent); only the alertsFiredTotal/alertsAcknowledgedTotal counters and the alertsActive gauge drift. Real but observability-only, and only on the rare commit-retry path.

### 203. [LOW · error-handling] `packages/db/src/cache/nodeDiffCache.js:56`

**Cache read failure aborts the whole diff computation instead of degrading to a miss**

In `get()`, the adapter read `const row = await this.adapter.getNodeDiffCache(...)` (line 56) sits OUTSIDE the try/catch, which only wraps `JSON.parse` (lines 58-70). If `getNodeDiffCache` rejects (e.g. SmithersError from a locked SQLite DB, transient read failure, or a table-missing race during migration), `get()` rejects, so in `getOrCompute` the line `const hit = await this.get(key)` (line 78) throws and the entire diff computation fails — even though it could have fallen through to `compute()`. This is inconsistent with the WRITE path in the same method, which explicitly catches and logs upsert failures (lines 95-102, 'Failed writing node diff cache row.') and continues. A cache should be best-effort on both reads and writes; the asymmetry is evidence the read path intended the same tolerance.

**Fix:** Wrap the adapter read in try/catch in `get()` (or wrap the `await this.get(key)` call in getOrCompute), logging a warn and returning null on adapter error so computation proceeds and recomputes the diff.

*Verifier:* Confirmed: in get() (nodeDiffCache.js:56) the adapter read `await this.adapter.getNodeDiffCache(...)` is outside the try/catch, which only wraps JSON.parse (lines 58-70). getNodeDiffCache delegates to `this.read(...)` (adapter.js:2442-2446), a RunnableEffect that rejects with SmithersError on a DB fault (locked DB, missing table, transient read). On rejection get() rejects, and in getOrCompute (line 78) `await this.get(key)` propagates, aborting the diff. The sole production caller (server/getNodeDiff.js:415,424,431) wraps cache.get/getOrCompute without catching, so a transient read failure fails the diff endpoint instead of recomputing. The write path explicitly catches upsert failures and continues (lines 95-102), so the asymmetry is real and the read path is not best-effort. Low severity: requires a DB-layer fault, and compute could otherwise have succeeded.

### 204. [LOW · correctness] `packages/db/src/zodToCreateTableSQL.js:76`

**Column identifier in CREATE TABLE is not escaped (raw quote wrapping)**

In zodToCreateTableSQL the user-derived column name is interpolated with a raw double-quote wrapper: colDefs.push(`"${name}" ${columnType(dialect, sqliteType)}`) (line 76). Every other identifier in this file goes through quoteIdentifier() which doubles embedded quotes: the table name on line 81 (quoteIdentifier(tableName)) and, notably, the SAME column name on line 119 in the ALTER path (quoteIdentifier(name)). `name` comes from camelToSnake(key) of the user's Zod schema object keys. A schema key containing a double quote (e.g. z.object({ 'we"ird': z.string() })) produces broken DDL like "we"ird" TEXT, corrupting the CREATE statement and allowing identifier injection into the DDL. The CREATE path is inconsistent with the ALTER path which handles it correctly.

**Fix:** Use the existing helper: colDefs.push(`${quoteIdentifier(name)} ${columnType(dialect, sqliteType)}`) so embedded quotes are doubled, matching line 119.

*Verifier:* Confirmed at line 76: `colDefs.push(`"${name}" ${columnType(...)}`)` interpolates the column name with a raw double-quote wrapper instead of quoteIdentifier(). quoteIdentifier (line 44) doubles embedded quotes; it is used for the table name (line 81) and notably for the SAME column name in the ALTER path (line 119: `quoteIdentifier(name)`) and the Postgres ALTER path (line 158). `name` = camelToSnake(key); camelToSnake.js only does case conversion (regex /([A-Z])/g + toLowerCase) and does NOT strip quotes, and assertNoReservedColumns only rejects reserved names (run_id/node_id/iteration), not quote characters. So a Zod schema key containing a double quote (e.g. z.object({'we"ird': z.string()})) yields `"we"ird" TEXT`, corrupting the CREATE statement, while the ALTER path produces correct `"we""ird"`. Genuine inconsistency and correctness defect. Severity low: requires an unusual schema key containing a literal double quote, so real-world impact and exploitability are minimal.

### 205. [LOW · error-handling] `packages/driver/src/WorkflowDriver.js:519`  _(corroborated ×2)_

**Abort during a deadlined wait rejects the deadline sleep, throwing out of nextCompletionDecision instead of returning cancelRun()**

In `nextCompletionDecision`, when `deadlineMs != null` the deadline racer is `sleepWithAbort(deadlineMs, this.activeOptions?.signal).then(() => null)` (line 519), pushed into `Promise.race(racers)` (line 521). `sleepWithAbort` REJECTS with an AbortError when the signal aborts (lines 211-215 / via withAbort), and the `.then(() => null)` only handles resolution, not rejection. If the run is aborted while it is in a RetryBackoff/Timer wait with still-pending inflight tasks (the only path that sets a non-null deadline, via `handleWait` lines 590-595), the sleep's abort rejection races the inflight tasks' clean cancelled settlement; because the rejected sleep settles in fewer microtask hops it typically wins, so `Promise.race` rejects and the AbortError propagates out of `nextCompletionDecision`/`run()` rather than reaching the `if (signal.aborted) return this.cancelRun()` check on line 532. This bypasses the intended `session.cancelRequested()` cancellation path. Impact is mitigated because the engine caller (packages/engine/src/engine.js:5942) catches `isAbortError(err)` and converts it to a cancelled result, but any other caller of `WorkflowDriver.run` gets a thrown AbortError instead of the documented `{status:"cancelled"}` RunResult.

**Fix:** Make the deadline racer swallow abort rejection, e.g. `sleepWithAbort(deadlineMs, signal).then(() => null, () => null)`, and let the post-race `if (this.activeOptions?.signal?.aborted) return this.cancelRun()` handle cancellation uniformly.

*Verifier:* Confirmed structurally. Line 519 pushes `sleepWithAbort(deadlineMs, signal).then(() => null)` into the race. sleepWithAbort REJECTS on abort (lines 211-215 and via `await withAbort(sleep, signal)` which rejects through abortPromise), and `.then(() => null)` only maps fulfillment, not rejection, so that racer rejects. Promise.race(racers) at line 521 then rejects and the AbortError propagates out of nextCompletionDecision (after the finally), through executeTasks/handleWait, out of run()'s untry'd loop, bypassing the line 532 `if (signal.aborted) return this.cancelRun()` check. This is a genuine contract violation (run() promises Promise<RunResult> but can throw). It is a microtask race against the inflight task's clean cancelled settlement, so it does not fire every time, and it is mitigated for the primary caller: engine.js line ~5941 catches `isAbortError(err)` and converts to a cancelled result. Reachable only when deadlineMs != null (RetryBackoff/Timer with inflight>0) and the signal aborts during that wait. Real but low impact and racy, hence medium confidence.

### 206. [LOW · resource-leak] `packages/electric-proxy/src/createSmithersElectricProxy.ts:359`

**Active-slot TTL sweep reclaims rate-limit slots but never cancels the upstream reader and leaves the activeShapes gauge stale**

`sweepExpired` (lines 359-370) marks a stuck slot `released` and deletes it from the set, but does two incomplete things: (1) it does not cancel the underlying upstream stream/reader for that abandoned shape, so the upstream Electric connection is leaked even though its rate-limit slot is reclaimed; (2) it does not call `metrics.setActiveShapes(...)`. The gauge is only refreshed on a successful `acquireActive` (line 642) or `releaseActive` (line 646); on the 429 path (slot null at 638) `setActiveShapes` is never called, so after a sweep the `smithers_electric_active_shapes` gauge stays inflated until the next accepted open. Operators watching the gauge see phantom active shapes.

**Fix:** Have the sweep (and the acquire/429 paths) refresh the gauge, and either keep a reference to the wrapped stream so a swept slot can cancel its upstream reader, or document that TTL reclaim only frees the slot.

*Verifier:* Confirmed on both points. sweepExpired (359-370) sets slot.released=true and deletes the slot from the set, reclaiming the rate-limit slot, but (1) it has no reference to the wrapBody reader/upstream stream (the rate limiter only knows ActiveSlot), so the upstream Electric connection for an abandoned-but-still-connected client is not cancelled — the TTL only frees the slot, giving a false impression of cleanup (note: bounded somewhat because the upstream fetch uses request.signal, so it does abort if the client disconnects). (2) setActiveShapes is only called after a successful acquireActive (642) and in release() (646); on the 429 path (slot===null at 638) it is not called, so when a sweep reclaims other keys' expired slots but this key still exceeds activeMax, the gauge stays inflated until the next accepted open. Both are real but minor (transient telemetry inaccuracy + narrow leak), hence low.

### 207. [LOW · correctness] `packages/electric-proxy/src/createSmithersElectricProxy.ts:650`

**Upstream fetch failure double-counts a single open as both shapeOpens and shapeOpenRejected**

`metrics.incShapeOpen()` runs at line 650 before the upstream `fetchClient` call. If the upstream fetch rejects, the `.catch` at 666 calls `release()` and rethrows; the error propagates to the `fetch` handler's catch (line 716-718) which calls `metrics.incShapeOpenRejected()` and returns 502. So one failed open increments BOTH `shapeOpens` and `shapeOpenRejected`. The rejected counter is documented as 'rejected by auth, scope, or rate limits' (metrics file lines 61-63), so upstream-unavailable errors are miscategorized and the two counters no longer sum/partition opens correctly.

**Fix:** Either move `incShapeOpen()` to only count successfully-forwarded opens, or use a distinct counter (e.g. an upstream-error metric) for the 502 path instead of `incShapeOpenRejected`.

*Verifier:* Confirmed. metrics.incShapeOpen() runs at line 650, before the upstream fetchClient call (662). The .catch at 666-669 calls release() and rethrows; the rejection propagates out of handleShape and is caught by the fetch handler at 716-718, which calls metrics.incShapeOpenRejected() and returns 502. So a single upstream-unavailable failure increments BOTH shapeOpens and shapeOpenRejected. The metrics help text confirms the mismatch: smithers_electric_shape_opens_total = 'opens accepted' (line 58) and shape_open_rejected_total = 'rejected by auth, scope, or rate limits' (line 61). A 502 upstream error is none of those, so it is miscategorized and the counters no longer partition opens. Real but telemetry-only, hence low.

### 208. [LOW · correctness] `packages/electric-proxy/src/createSmithersElectricProxy.ts:687`

**Per-shape forwarded event reports the proxy-wide cumulative byte counter, not this shape's bytes**

In the `electric.shape.forwarded` event, `forwardedBytes: metrics.snapshot().forwardedBytes` reads the shared, monotonically-increasing process-wide counter (`addForwardedBytes` is called for every shape's bytes in `wrapBody`). The emitted event is per-shape (it carries this shape's principal/table/durationMs), so consumers will read the global total as this stream's byte count. Every forwarded event over-reports, and the value only ever grows, making per-shape byte telemetry meaningless.

**Fix:** Track a per-stream byte counter inside `wrapBody` (accumulate `value.byteLength`) and pass that captured count into the forwarded event instead of `metrics.snapshot().forwardedBytes`.

*Verifier:* Confirmed. The metrics object holds a single process-wide cumulative counter state.forwardedBytes, incremented by addForwardedBytes for every shape's chunk (createSmithersElectricProxy line 515). snapshot() returns {...state}, so snapshot().forwardedBytes is the global total. The electric.shape.forwarded event (lines 681-689) is per-shape (it carries this shape's principalId/table/durationMs/status) yet sets forwardedBytes: metrics.snapshot().forwardedBytes, i.e. the global monotonic total. So every forwarded event over-reports per-shape bytes with an ever-growing global value. Genuine telemetry correctness bug, but only telemetry, hence low.

### 209. [LOW · performance] `packages/electric-proxy/src/serveSmithersElectricProxy.ts:47`

**No backpressure: res.write return value ignored, slow client causes unbounded buffering**

In `writeFetchResponse` the body is piped with `if (value) res.write(Buffer.from(value));` inside a tight `await reader.read()` loop. The boolean returned by `res.write` (false = kernel/socket buffer full) is ignored, and the loop never waits for the socket `"drain"` event. When a client reads slowly (or stops reading) while the upstream Electric shape keeps producing bytes, chunks accumulate without bound in Node's internal socket write buffer. The per-frame `createFrameBoundScanner` bounds a single SSE frame but not the total queued bytes, so a slow consumer of a large/continuous shape can drive the proxy process to OOM. A streaming proxy must honor backpressure.

**Fix:** Respect the return value: `if (value && res.write(Buffer.from(value)) === false) { await new Promise(r => res.once('drain', r)); }` (and bail out / cancel the reader if the response is closed), or use `pipeline()`/`Readable.fromWeb(response.body).pipe(res)` which handles backpressure and abort automatically.

*Verifier:* Confirmed. writeFetchResponse (lines 44-48) ignores the boolean returned by res.write(Buffer.from(value)) and never awaits a 'drain' event, reading from the upstream wrapped stream as fast as it resolves. createFrameBoundScanner (createSmithersElectricProxy.ts line 495/516) bounds only a single SSE frame, not total queued bytes. With a slow/stalled downstream client and a continuous upstream shape, Node buffers unboundedly in the socket writable buffer — a real backpressure omission (a correct streaming proxy would use pipeline or honor write()'s false/'drain'). Real defect, but low severity in practice since Electric shapes are typically not huge continuous streams.

### 210. [LOW · correctness] `packages/engine/src/effect/builder.js:460`

**Approval decision output always reports decidedAt: null, dropping the real decision timestamp**

In `executeStepHandle`'s approval branch the code reads the persisted approval row and maps `decidedBy` correctly but hardcodes the timestamp to null:

```
decidedBy: approval?.decidedBy ?? null,
decidedAt: null,
```

The `ApprovalDecision` schema declares `decidedAt: Schema.NullOr(Schema.String)`, clearly meant to carry when the decision was made. The fetched `approval` row does contain the timestamp (the approvals table stores `decided_at_ms` -> `decidedAtMs`, see packages/db/src/adapter/ApprovalRow.ts). Because it is unconditionally overwritten with null, every approval step's output reports `decidedAt: null`, so any downstream consumer or audit relying on the approval timestamp gets no value. (Note the field name mismatch: the row exposes `decidedAtMs` as a number, not `decidedAt` as a string, which looks like the reason it was left null rather than converted.)

**Fix:** Populate decidedAt from the row, e.g. `decidedAt: approval?.decidedAtMs != null ? new Date(approval.decidedAtMs).toISOString() : null`.

*Verifier:* executeStepHandle approval branch (lines 459-460) sets decidedBy: approval?.decidedBy ?? null but decidedAt: null unconditionally. getApproval does SELECT * (adapter.js:1657) so the awaited row contains decidedAtMs (ApprovalRow.ts:7, number|null) AND decidedBy (used here), proving the timestamp is available but discarded. ApprovalDecision schema (line 74) declares decidedAt: Schema.NullOr(Schema.String) to carry it. The asymmetry (decidedBy populated, decidedAt always null) is a clear oversight; the real decision timestamp is dropped from every approval output. Low impact: cosmetic/audit data loss only.

### 211. [LOW · error-handling] `packages/engine/src/effect/builder.js:1173`  _(corroborated ×2)_

**Workflow execution failures thrown inside Effect.promise become uncatchable defects**

The `use` callback of `acquireUseRelease` is wrapped in `Effect.promise(async () => { ... })`. Inside it, a failed run is surfaced via `throw normalizeExecutionError(result)` (line ~1190), and `extractResult`/`Promise.all` (parallel) can also reject. `Effect.promise` is documented for promises that NEVER reject: any rejection/throw is converted into an unrecoverable DEFECT (die), not a typed failure. So a workflow that ends with status "failed" raises a `SmithersError` that is intended to be a recoverable failure channel, but it lands as a defect. Callers composing the returned Effect with `Effect.catchTag("WORKFLOW_EXECUTION_FAILED", ...)`, `Effect.catchAll`, or `Effect.retry` will not catch it (catchAll only handles the error channel, not defects), so error recovery/retry around `workflow.execute()` silently fails to engage. The `throw` of a typed SmithersError is clearly meant to be a catchable failure, so the wrapping in `Effect.promise` is a contract bug.

**Fix:** Use `Effect.tryPromise({ try: async () => {...}, catch: (e) => e })` for the `use` body so intentional throws (and extractResult/Promise.all rejections) surface as typed failures in the error channel rather than defects.

*Verifier:* Line 1173 wraps the use callback in Effect.promise(async()=>{...}), and line 1190 does `throw normalizeExecutionError(result)` for status 'failed'. Effect.promise semantics: a throw/rejection becomes an unrecoverable defect (die), not a typed failure in the error channel. normalizeExecutionError builds a typed SmithersError(WORKFLOW_EXECUTION_FAILED) — documented as a typed error — clearly signaling recoverable intent. So Effect.catchAll/catchTag/retry composed on the public wf.execute() Effect would silently not engage (they act on the error channel, not defects). Reachability confirmed by the 'normalizes failed builder workflow execution' test. Marked low not medium: runPromise still rejects either way and no current caller composes recovery, so today's observable impact is minimal; it is a real footgun for the exported Effect-returning API.

### 212. [LOW · error-handling] `packages/engine/src/effect/compute-task-bridge.js:531`  _(corroborated ×2)_

**eventBus.flush() rejection after a successful compute mis-marks the attempt as failed and can double-run computeFn**

In the success path the compute callback has already fully succeeded and produced a validated `payload` by line 509-529. The remaining pre-persist work then runs inside the same `try`: `await Effect.runPromise(eventBus.flush())` (line 531). `getJjPointer` (line 532) cannot reject (its Effect error channel is `never`), but `eventBus.flush()` persists queued events and CAN reject (e.g. a transient DB lock/write error). If it rejects, control jumps into the `catch` block. There `heartbeatTimeoutError` is null and `taskSignal.aborted`/`isAbortError(flushError)` are false, so `aborted === false` and the code takes the FAILED path (lines 661-711): it writes the attempt as `state:"failed"` with `errorJson` set to the flush error, emits `NodeFailed`, and if retries remain emits `NodeRetrying`. The successful compute output row is NEVER persisted (the upsert is only at line 538 in the success path). On retry the driver re-executes `desc.computeFn()`, so a non-idempotent compute callback (side effects already performed: counter increment, external request, file write) runs twice, and the failure is misattributed to a flush error rather than the real (successful) result. This is a genuine correctness/data-integrity risk; the trigger (flush throwing) is uncommon, hence low confidence. Note this pattern is shared with engine.js/static-task-bridge, so it may be an accepted architectural choice.

**Fix:** Treat post-compute bookkeeping (eventBus.flush) failures distinctly from compute failures: wrap the success-path flush in its own try/catch that logs but does not abort the completion, OR perform the output-row upsert/attempt-finished transaction before flushing events so a flush error cannot revert a persisted success.

*Verifier:* Confirmed in actual code. Success path: line 530 sets taskExecutionReturned=true, line 531 `await Effect.runPromise(eventBus.flush())` runs BEFORE the only output persist (upsertOutputRow at line 538). flush() CAN reject: events.js:69-81 awaits persistTail then rethrows this.persistError (set at line 113-114 when a background queued-persist fails, e.g. a TaskHeartbeat event persist during compute). On rejection, control jumps to catch (line 580): heartbeatTimeoutReasonFromAbort returns null, taskSignal.aborted is false, and isAbortError on a 'flush queued events' SmithersError is false (code != TASK_ABORTED, message won't match /aborted|abort/i), so aborted===false and the FAILED path (658-711) runs: attempt marked failed with errorJson, NodeFailed emitted, NodeRetrying emitted if retries remain. The computed output is never persisted, so the driver re-runs desc.computeFn() on retry, doubling side effects. The finding's note that getJjPointer cannot reject is correct (jj.js error channel is `never`, runJj uses Effect.catchAll). Trigger is narrow (requires queued heartbeat events + transient persist failure), hence low severity, but the data-integrity/double-execution consequence is genuine.

### 213. [LOW · resource-leak] `packages/engine/src/engine.js:81`

**Module-global createdWorktrees Set grows unbounded across runs and is functionally dead as a guard**

`const createdWorktrees = new Set();` is module-level state shared by every run in the process (e.g. inside the long-lived gateway/server). In `ensureWorktree`, paths are added at lines 761 and 847 but the only branch that reads the Set (lines 764-766) merely deletes the entry and does not short-circuit creation — the actual dedup is done by `existsSync(worktreePath)`. So the Set never prevents re-creation (its documented purpose at line 78), and entries accumulate forever in a persistent process, a slow memory leak. It is also process-global rather than per-run, so it cannot represent "this run" as the comment claims.

**Fix:** Either remove the Set entirely (since existsSync already guards creation) or scope it per-run and clear it at run completion so it cannot grow without bound.

*Verifier:* Confirmed: `createdWorktrees` is module-global (line 81), added at 761 and 847, and the only read at 764-766 just deletes the entry without short-circuiting creation. Real dedup is existsSync(worktreePath) at 742. So the Set is a functionally-dead guard and, in a long-lived process (gateway), accumulates one string per distinct worktree path ever seen (delete only fires on the rare path where the dir vanished off disk). Genuine dead code + minor unbounded growth, though each entry is tiny.

### 214. [LOW · error-handling] `packages/engine/src/engine.js:116`

**runAgentPreflightOnce caches rejected preflight promise, poisoning all later attempts**

In `runAgentPreflightOnce` the promise is stored in the cache before it settles:

```js
const promise = Promise.resolve()
    .then(() => agent.preflight(options))
    .then(() => undefined);
cache.set(agentObject, promise);
await promise;
```

If `agent.preflight(options)` rejects (e.g. a transient auth/network failure, or the agent CLI momentarily unavailable), the rejected promise stays in the cache. The cache (`toolConfig.agentPreflightCache`, a `WeakMap` created once per run at line 4890) is shared across every task attempt and every task that reuses the same agent object. On the very next call `const existing = cache.get(agentObject)` is truthy, so `await existing` re-throws the original error and the code never re-runs preflight. The result: a single transient preflight failure permanently fails preflight for that agent for the rest of the run, defeating the retry machinery (the failed attempt at line 3307 can never recover even though the underlying condition cleared). Successful preflight should be cached, but failures must not be.

**Fix:** Only cache the promise after it resolves successfully, or evict it on rejection, e.g.: `const promise = Promise.resolve().then(() => agent.preflight(options)).then(() => undefined); promise.catch(() => cache.delete(agentObject)); cache.set(agentObject, promise); await promise;` so a rejected preflight is removed and re-attempted next time.

*Verifier:* Confirmed at lines 116-121: the promise is stored in the per-run WeakMap (toolConfig.agentPreflightCache, created at 4890) BEFORE it settles, and the rejection is never deleted. A later call hits `existing` truthy (112) and re-awaits the rejected promise, re-throwing forever. This poisons every other task in the run that reuses the same agent object. Severity adjusted down: the catch at 3307 already converts ANY preflight failure into a non-retryable AGENT_CONFIG_INVALID, so the first failure already fails the run non-retryably; the caching mainly prevents cross-task recovery of a genuinely transient blip. Still a real rejected-promise-caching anti-pattern.

### 215. [LOW · correctness] `packages/engine/src/engine.js:2283`

**ralphIterationsObject scope resolution depends on unspecified Map iteration order for 3+ level nested loops**

In `ralphIterationsObject` the second pass resolves a scoped ralph id like `inner@@mid=1,outer=2` by comparing each scope part against the *logical* shortcut: `const currentAncestorIter = obj[ancestorId]; if (currentAncestorIter !== ancestorIter) { isCurrent = false; break; }` (lines 2283-2287). For a 2-level nest the ancestor (`outer`) is a top-level unscoped entry whose value is fixed in the first pass, so it is order-independent. But for 3+ nested ralph loops the ancestor (`mid`) is ITSELF a scoped ralph whose logical shortcut `obj['mid']` is only assigned during this same second-pass loop (line 2290). The loop iterates `state.entries()` in Map insertion order, which equals the row order from `adapter.listRalph` — and that query has NO `ORDER BY` (packages/db/src/adapter.js:2298-2300 `SELECT * FROM _smithers_ralph WHERE run_id = ?`). If a descendant-scoped row (`inner@@mid=1,outer=2`) is yielded before its ancestor row (`mid@@outer=2`) is processed, `obj['mid']` is still the init value 0, the `!==` comparison fails, `inner` is treated as not-current, and the logical shortcut `obj['inner']` is left at 0 instead of its real iteration. This object is passed straight into the scheduler as `initialIterations: ralphIterationsObject(ralphState)` (line 5933), so a deeply-nested loop resumes/seeds with the wrong iteration — re-running already-completed inner iterations or mis-scoping work. Row order is genuinely unspecified on the PGlite/Postgres backends (and can change on SQLite after row updates), so this is a non-deterministic correctness bug rather than a guaranteed-safe ordering.

**Fix:** Make the resolution order-independent: either add a deterministic `ORDER BY` to `listRalph` that guarantees ancestors precede descendants (e.g. by scope depth / creation order), or resolve `ralphIterationsObject` to a fixpoint (repeat the scoped-pass until no `obj[...]` value changes) so ancestor shortcuts are settled before descendants are compared.

*Verifier:* Structurally confirmed. ralphState is built from listRalph via buildRalphStateMap (5730), and listRalph has NO ORDER BY (adapter.js:2298-2300), so Map insertion order = unspecified DB row order on PG/PGlite. In ralphIterationsObject the second pass (2266-2292) reads `obj[ancestorId]` (2283); for 3+ level nesting an ancestor like `mid` is itself scoped, so `obj['mid']` is the logical shortcut that is only assigned during this same pass (2290). If a descendant `inner@@mid=1,outer=2` is processed before `mid@@outer=2`, obj['mid'] is still the init 0 and inner is wrongly treated as not-current. Result feeds initialIterations at 5933. Real but narrow: requires 3+ nested ralph loops, a Postgres/PGlite backend, and unfavorable row order; severity lowered accordingly.

### 216. [LOW · error-handling] `packages/engine/src/engine.js:2730`

**Heartbeat persistence failure silently drops the pending heartbeat snapshot**

In `flushHeartbeat`, `heartbeatHasPendingWrite = false;` is set at line 2730 *before* the `await adapter.heartbeatAttempt(...)` write (line 2740). If that write throws, the catch at 2761 only logs a warning and does not restore `heartbeatHasPendingWrite` or re-queue the captured `heartbeatDataJson`. The captured heartbeat snapshot is therefore lost and never retried. The in-run liveness watchdog is unaffected (it reads in-memory `heartbeatPendingAtMs`), but the *persisted* heartbeat is what a resumed/crash-recovered attempt reads back as `previousHeartbeat` (lines 2671-2678) to hand the agent its last progress. If the final heartbeat before a crash fails to persist (transient DB error) and no newer heartbeat arrives to overwrite the pending slot, recovery resumes with stale heartbeat data.

**Fix:** In the catch block, restore `heartbeatHasPendingWrite = true` (and keep the pending payload) so the finally-block re-flush retries the write, or only clear `heartbeatHasPendingWrite` after a successful persist.

*Verifier:* Confirmed. flushHeartbeat sets `heartbeatHasPendingWrite = false` at 2730 before the await at 2740. The catch at 2761 only logs; it does not restore the flag or re-queue, and the finally (2770-2779) only retries if `heartbeatHasPendingWrite` is truthy (it isn't). The captured snapshot is dropped. Note heartbeatPendingDataJson itself is NOT cleared, so a subsequent queueHeartbeat re-arms a write; the loss only bites the final heartbeat before a crash with no follow-up. Genuine low-severity error-handling gap.

### 217. [LOW · error-handling] `packages/engine/src/engine.js:3080`

**JSON.parse of cached payload has no try/catch; a corrupt cache row crashes the task attempt instead of being a cache miss**

On a fresh, non-expired cache row the code does `const parsed = JSON.parse(cachedRow.payloadJson);` (line 3080) with no try/catch, unlike the cache-key serialization which is wrapped (lines 3046-3060). If `payloadJson` is corrupt/truncated in the DB, this throws synchronously inside the task try-block and surfaces as a task execution failure (consuming a retry / failing the node) rather than degrading to a cache miss + re-execution.

**Fix:** Wrap the parse+validate in try/catch; on parse error increment cacheMisses, log a warning, and fall through to normal execution (leave payload null).

*Verifier:* Confirmed. Line 3080 `const parsed = JSON.parse(cachedRow.payloadJson)` is inside the task try-block with no try/catch, unlike the cache-key serialization which is wrapped (3046-3060). A corrupt/truncated payloadJson throws and surfaces as a task execution failure (caught at 3663) consuming a retry, instead of degrading to a cache miss + re-execution. Low severity/edge: payloadJson is written by JSON.stringify so corruption is unlikely, but the defensive inconsistency is real.

### 218. [LOW · error-handling] `packages/engine/src/engine.js:3655`

**durability.stop()/docFileSync.stop() in finally can mask the agent result or original error**

The agent `generate` call is wrapped as:
```js
finally {
  if (hijackPollingInterval) clearInterval(hijackPollingInterval);
  try { await durability.stop(); }
  finally { await docFileSync.stop(); }
}
```
These stop() calls run in the `finally` of the inner try whose body assigns `result`. If `durability.stop()` (or `docFileSync.stop()`) rejects, the thrown rejection escapes the `finally` and replaces the normal outcome: a successful agent run is turned into a thrown error routed to the `catch` at line 3663 and reported as a task failure, and if `generate` itself already failed the cleanup error masks the real agent error. Both stop() paths are described as best-effort/no-op, so their failures should never override the task outcome.

**Fix:** Wrap each cleanup in its own try/catch that logs and swallows (best-effort), so cleanup failures cannot replace the agent's real result or error.

*Verifier:* Confirmed but gated. The finally at 3649-3661 awaits durability.stop() then docFileSync.stop() with no surrounding catch, so a rejection escapes and replaces the result, masking a successful run or the real generate error (routed to catch at 3663). durability.stop() (startDurability.js:132-141) does `await watchSnapshot({})` and pruneWorkspaceDurability with no internal try/catch, so it can reject on a DB error. When disabled (default), stop is a no-op async (line 40) that never throws, so this only manifests with SMITHERS_DURABILITY_SNAPSHOTS=1. docFileSync.stop guards its await with .catch (startDocFileSync.js:82) but watcher.flush/close could still throw synchronously. Real, low/conditional.

### 219. [LOW · api-misuse] `packages/engine/src/engine.js:3907`

**JSON-repair retry generate omits rootDir and maxOutputBytes**

The context-free JSON repair retry calls:
```js
const retryResult = await effectiveAgent.generate({
  options: undefined,
  abortSignal: taskSignal,
  prompt: jsonPrompt,
  timeout: desc.timeoutMs ? { totalMs: desc.timeoutMs } : undefined,
  onStdout: ..., onStderr: ...,
});
```
Unlike the primary `generate` (which passes `rootDir: taskRoot` and `maxOutputBytes: toolConfig.maxOutputBytes`) and the schema-retry `generate` at line 4152 (which passes both), this repair call passes neither. For CLI-backed agents the spawned process falls back to a default cwd (typically the repo root, not the task's isolated worktree) and the default stdout cap, which can change the agent's working context and truncation behavior relative to the configured run.

**Fix:** Pass `rootDir: taskRoot` and `maxOutputBytes: toolConfig.maxOutputBytes` to the repair-retry generate call for consistency with the other generate sites.

*Verifier:* Confirmed. The context-free JSON-repair generate (3907-3920) passes only options/abortSignal/prompt/timeout/onStdout/onStderr. The primary generate passes rootDir: taskRoot and maxOutputBytes (3613,3620) and the schema-retry generate passes both (4156-4157). For CLI-backed agents the repair spawn falls back to a default cwd (not the task's worktree) and default output cap, diverging from the configured run. Real low-severity api-misuse.

### 220. [LOW · correctness] `packages/engine/src/engine.js:4228`

**Schema-retry JSON extraction uses the FIRST brace, regressing the #277 "use last JSON" protection**

The balanced-brace fallback in the schema-retry path scans from the first `{`: `const jsonStart = retryText.indexOf("{");`. The primary parse path deliberately uses last-balanced extraction (line 3859, `extractLastBalancedJson(text)`) with the explicit comment "search from END so we get the required output JSON, not an earlier JSON object from intermediate tool output". When an agent emits any earlier `{...}` (tool-call echo, reasoning that quotes a JSON snippet, or intermediate tool output) before the final corrected object, this inline extractor parses the first object and, if it happens to be valid JSON, validates and persists the WRONG payload instead of the final answer. The non-greedy fence regex on line 4218 (`\{[\s\S]*?\}`) also stops at the first `}` for nested objects, but that case falls through to this first-brace extractor, so the net result still prefers the earliest object.

**Fix:** Use the shared `extractLastBalancedJson(retryText)` helper here (as the primary path does) instead of an inline first-brace scan, so the final object wins.

*Verifier:* Confirmed inconsistency. The schema-retry balanced-brace fallback scans from the FIRST `{` via `retryText.indexOf('{')` (4228), whereas the primary path deliberately uses extractLastBalancedJson (3859) with the explicit #277 comment to search from the end and skip earlier intermediate JSON. If the retry response contains an earlier `{...}` (tool echo / quoted snippet) before the final corrected object, the first-brace scan parses the earlier object; if it happens to pass schema validation (4267) the wrong payload is persisted. The non-greedy fence regex (4218) also stops at the first `}`, falling through to this first-brace extractor. Real, low (retry responses are usually clean).

### 221. [LOW · logic] `packages/engine/src/hot/watch.js:317`

**flush() drops buffered file changes when no consumer is waiting**

`flush()` unconditionally drains the buffer before checking for a waiter:

```js
flush() {
  if (this.changedFiles.size === 0) return;
  const files = [...this.changedFiles];
  this.changedFiles.clear();   // <-- cleared even with no waiter
  ...
  if (this.waitResolve) {       // only delivered if someone is waiting
    this.waitResolve(files);
    this.waitResolve = null;
  }
}
```

`flush` is only ever invoked by the debounce timer set in `onFileChange`. The `wait()` immediate-return path (`if (this.changedFiles.size > 0) { ...clear; return Promise.resolve(files); }`) proves the buffer is designed to survive between `wait()` calls so a change that arrives while the consumer is busy is picked up on the next `wait()`. But because the debounce timer fires after only `debounceMs` (default 100ms), any change that occurs while no consumer is actively in `wait()` (the normal case while `HotWorkflowController.reload()` is running an overlay build + dynamic import, which usually takes well over 100ms) gets cleared by `flush()` with `waitResolve === null`, and the notification is lost. It is not recovered by polling either: `recordScanChanges` already set `this.fileSignatures = next` when it detected the change, so the next poll sees no diff and never re-adds the file. The result: a file edit saved during an in-progress hot reload is silently swallowed, and no reload happens until the user saves again. This defeats the buffering the code clearly intends to provide.

**Fix:** In `flush()`, only drain `changedFiles` when there is actually a waiter to hand them to. e.g. `if (!this.waitResolve) return;` before computing/clearing `files`, leaving the buffer intact so the next `wait()` returns it via the immediate-return path. (Keep clearing only when delivered.)

*Verifier:* Confirmed against the code. flush() (watch.js:317-331) clears changedFiles unconditionally at line 321, but only delivers files when waitResolve is set (line 327). The consumer (HotWorkflowController) calls wait() then reload() (buildOverlayEffect + dynamic import, >100ms) then wait() again; during reload no waiter is registered. A change in that window is buffered, the 100ms debounce fires flush() which clears it with waitResolve===null, dropping the notification. It is not recovered by polling because recordScanChanges sets this.fileSignatures = next (line 261) when the change is first detected, so subsequent polls see no diff. The immediate-return buffered paths in wait() (58-62) and waitEffect() (123-128) confirm buffering is intended to persist between consumer calls, which flush's unconditional clear defeats. Real correctness defect, but dev-only hot-reload and recoverable by re-saving, so low impact.

### 222. [LOW · performance] `packages/engine/src/json-extraction.js:48`

**extractLastBalancedJson is O(n^2) on deeply nested JSON in agent output**

`extractLastBalancedJson` calls `extractBalancedJson(str.slice(pos))` for every `{` position (line 53) and re-slices/re-scans from each. For deeply nested input like `{"a":{"a":{"a":...}}}` the number of `{` is proportional to nesting depth and each scan walks the remaining substring, giving O(n^2) work plus O(n^2) string allocation from repeated `str.slice`. Agent text fed in at engine.js:3859 can be large (the engine truncates around hundreds of KB), so a pathological/deeply-nested response can burn seconds of CPU and large transient memory on every task completion.

**Fix:** Scan once: track candidate object spans in a single linear pass instead of slicing and re-scanning from every brace, or pass an offset into extractBalancedJson rather than allocating str.slice(pos) each iteration.

*Verifier:* Confirmed in code: extractLastBalancedJson (lines 48-64) loops over every '{' via str.indexOf and for each calls extractBalancedJson(str.slice(pos)) (line 53). Each str.slice allocates an O(n) substring and extractBalancedJson scans linearly to the matching brace, so for input with O(n) opening braces (deeply nested JSON like {"a":{"a":...}} or {{{{...) total time and transient memory are O(n^2). The caller engine.js:3859 passes raw agent text (truncated to ~hundreds of KB), so pathological/deeply-nested output can burn CPU and large transient memory. The defect genuinely exists. Impact is correctly low/performance: normal agent JSON has few '{' and input is truncated, so the quadratic term only manifests on adversarial/pathological nesting, and it is a perf issue, not a correctness/crash/security bug.

### 223. [LOW · error-handling] `packages/engine/src/workflow-hash.js:154`

**Swallowed import-resolution failure yields null graph hash, making valid workflows unresumable with a misleading error**

`readWorkflowGraphHash` wraps the whole traversal in `try { ... } catch { return null; }`. Inside, `collectWorkflowModuleHashEntries` throws `WORKFLOW_HASH_RESOLUTION_FAILED` whenever `resolveWorkflowImport` returns null for ANY relative specifier. `resolveWorkflowImport` only tries the extensions in `WORKFLOW_IMPORT_EXTENSIONS` (["", .ts, .tsx, .mts, .cts, .js, .jsx, .mjs, .cjs]) plus index files. A perfectly valid relative import that a bundler/TS resolves but this resolver cannot, e.g. an extensionless JSON import `import cfg from "./config"` where the file is `config.json`, or a directory whose entry is `index.json`, throws -> the catch turns the entire hash into null. In engine.js `assertResumeDurabilityMetadata` (lines 1822-1824) then does `if (!existingRun.workflowHash || !current.workflowHash) mismatches.push("workflow module graph unavailable")` and throws `RESUME_METADATA_MISMATCH`. So such a workflow becomes permanently non-resumable, and because the throw is swallowed the user never learns the real cause, instead getting the misleading hint that 'The workflow source changed.' A transient `readFile` error during resume causes the same false mismatch.

**Fix:** Do not treat an unresolvable relative import as fatal for hashing: skip (or record the unresolved specifier string in the hash) instead of throwing, or at minimum include `.json` and other commonly-importable extensions. Separately, distinguish 'hash unavailable due to internal resolver limitation' from 'hash changed' so resume is not blocked by the engine's own resolver gaps.

*Verifier:* The mechanism is real: collectWorkflowModuleHashEntries (lines 134-137) throws WORKFLOW_HASH_RESOLUTION_FAILED when resolveWorkflowImport returns null, and readWorkflowGraphHash (lines 150-156) swallows ALL errors to return null. At run start getRunDurabilityMetadata (engine.js:1731) stores that null without blocking, so the run executes fine; at resume, with storedDurabilityVersion>=DURABILITY_METADATA_VERSION (always set via buildDurabilityConfig:1762), line 1822 `if (!existingRun.workflowHash || !current.workflowHash)` pushes 'workflow module graph unavailable' and line 1843 throws RESUME_METADATA_MISMATCH, so a runnable workflow becomes non-resumable and the real cause (resolution failure or transient readFile error) is hidden. Two caveats lower severity and partly refute the claim: (a) the trigger is narrow because WORKFLOW_IMPORT_EXTENSIONS includes the empty-string candidate (line 108), so explicit-extension assets like './config.json' or './styles.css' DO resolve; only extensionless imports that the runtime can resolve but this resolver cannot (e.g. './config' -> config.json, or dir/index.json) fail, plus genuinely transient IO during resume; and the runtime must itself resolve the import for the workflow to have run at all. (b) The claim's stated hint ('The workflow source changed') is WRONG: 'workflow module graph unavailable' is not one of the strings isWorkflowEdit checks (line 1844 only matches 'workflow entry file changed'/'workflow module graph changed'), so the emitted hint is actually the 'workflow path or VCS root no longer matches' branch. Genuine but minor robustness defect; the swallow-to-null conflating transient IO with resolution failure is the substantive part.

### 224. [LOW · resource-leak] `packages/gateway-react/src/sync/createGatewayCollections.ts:178`

**Pulser stream leaks one AbortSignal 'abort' listener per invalidate pulse**

In `createPulser().stream`, each iteration of the `while (!signal.aborted)` loop creates a fresh Promise whose executor calls `signal.addEventListener("abort", () => { set.delete(resolve); resolve(); }, { once: true })` (lines 178-185). That listener is only ever removed when the signal actually aborts (the `{ once: true }` fires). On the NORMAL resolution path — when `pulse(fingerprint)` resolves the waiter — the listener is NOT removed, and the loop immediately starts a new iteration that registers yet another abort listener. The consumer in `createGatewayCollection.openStreamLoop` re-requests the next value synchronously after each yield, so a new iteration (and a new listener) is created for every pulse. The pollable list collections (runs/workflows/approvals/crons/memoryFacts/prompts/scores/tickets) all use this INVALIDATE_SCOPE pseudo-stream, and `invalidate()` (invoked after mutations / on demand) pulses them. So every invalidate adds a permanent abort listener to the collection's AbortSignal that lives until the collection is gc'd/cleaned up (listGcTime = 5 min, but re-created on use). Over a session with frequent mutations this accumulates unbounded listeners on each long-lived signal: growing memory plus Node's AbortSignal/EventTarget MaxListenersExceededWarning noise. The frames stored are bounded, but the abort-listener set is not.

**Fix:** Capture the abort handler in a variable and remove it after the await settles, regardless of how it resolved. E.g. inside the executor `const onAbort = () => { set.delete(resolve); resolve(); }; signal.addEventListener("abort", onAbort, { once: true });` and after the `await new Promise(...)` resolves, call `signal.removeEventListener("abort", onAbort)` so each iteration nets zero listeners.

*Verifier:* Confirmed in createGatewayCollections.ts lines 166-192. In the pulser stream generator, each `while (!signal.aborted)` iteration creates a new Promise whose executor calls `signal.addEventListener("abort", () => {...}, { once: true })`. `{ once: true }` only removes the listener if the abort event fires; on the normal resolution path (pulse() at lines 159-165 does set.clear() + resolve(), with no removeEventListener), the listener is never removed. The consumer in createGatewayCollection.ts:312 (`for await (const frame of iterable)`) re-requests the next frame after each yield, so every invalidate pulse advances the loop one iteration and registers one more permanent abort listener on the signal. invalidate() (lines 473-477) drives all pollable list collections this way after mutations, so listeners accumulate per pulse on each long-lived collection's signal. This is a genuine resource leak (EventTarget listener accumulation -> memory growth, possible Node MaxListenersExceededWarning). However it is functionally harmless (the leftover resolve is a no-op, set.delete is harmless) and bounded: when the collection is gc'd/reset the controller aborts, all accumulated once-listeners fire and auto-remove, and the signal is gc'd. gateway-react runs mostly in-browser where EventTarget has no max-listener warning. Real but low severity, not medium.

### 225. [LOW · logic] `packages/gateway-react/src/sync/useSyncSubscription.ts:55`

**Stream frames without a numeric seq are ordered in REVERSE (last = oldest, ring drops newest)**

useSyncSubscription orders the buffer with `const frames = useMemo(() => [...rows].sort((left, right) => left.id - right.id).map((row) => row.frame), [rows])` and returns `last: frames[frames.length - 1]`, both of which assume `row.id` increases with arrival order. But for frames that lack a numeric `seq`, the row id is generated in `streamHandle` (packages/gateway-react/src/sync/createGatewayCollections.ts:443,457) as `let nextSynthetic = -1; ... const rowId = typeof frame.seq === "number" ? frame.seq : nextSynthetic--;`. `nextSynthetic--` post-decrements, so consecutive seq-less frames get ids -1, -2, -3, … — i.e. ids DECREASE over time. `SyncStreamFrame.seq` is explicitly optional ('Server sequence number … missing on heartbeats', packages/gateway-client/src/sync/SyncTransport.ts:18-19) and the generic stream's frameToRows emits a row for every frame, so this path is reachable. Consequences for any seq-less stream: (1) the ascending sort reverses chronological order, (2) `last` returns the OLDEST frame instead of the newest, and (3) the ring eviction in createGatewayCollection (`Array.from(liveKeys).sort(keySort).slice(0, liveKeys.size - maxRows)` with ascending keySort, packages/gateway-client/src/sync/createGatewayCollection.ts:199-200) deletes the SMALLEST keys — which for decreasing synthetic ids are the NEWEST frames — so the bounded buffer keeps the stale oldest frames and throws away fresh ones. Mixed streams (some frames with seq, some heartbeats) also push all synthetic rows to the front of the buffer permanently.

**Fix:** Make synthetic ids increase with arrival so they stay consistent with the ascending sort and the ring eviction. In createGatewayCollections.ts streamHandle, use a monotonically increasing counter (e.g. start very negative and `nextSynthetic++`, or use a separate positive arrival counter and sort by it) instead of `nextSynthetic--`. Alternatively sort frames by arrival order rather than raw id.

*Verifier:* Code confirmed: createGatewayCollections.ts:443/457 assigns seq-less frames decreasing synthetic ids via `nextSynthetic--` (-1,-2,-3...), while useSyncSubscription.ts:54-59 sorts ascending by id and returns last=frames[len-1], and createGatewayCollection.ts:199-200 evicts the SMALLEST keys. The path is reachable: streamRunEvents emits run.heartbeat frames (SmithersGatewayClient.ts:307) that lack seq — proven by the sibling eventRows guard `if (typeof frame.seq !== "number") return []` (gatewayCollectionDefs.ts:46-47) and the SyncTransport.ts:18 comment 'missing on heartbeats'. The streamHandle frameToRows used by useGatewayRunStream does NOT drop them, so heartbeats become rows with negative decreasing ids -> they sort to the front in reverse order, and under maxRows the most-negative (newest heartbeats) are evicted first, leaving the stale oldest heartbeats; for a heartbeat-only buffer `last` is the oldest heartbeat. So the defect genuinely exists and produces wrong handling of heartbeat frames. However the claim overstates impact: real run events always carry a positive ascending seq, so they sort correctly, are never evicted before heartbeats, and `last` is the newest real event whenever any real event is present. The wrong behavior is confined to throwaway liveness heartbeat frames (reversed/stale ordering in the buffer, inflated `dropped` count), not real event data, so severity is low rather than medium.

### 226. [LOW · error-handling] `packages/gateway-react/src/useGatewayRunEvents.ts:60`

**Per-run event stream reports error/halt based on GLOBAL connection status**

`const streamFailed = Boolean(runId) && (connection.status === "offline" || connection.status === "unauthorized");` and then `streaming: Boolean(runId) && !live.isError && !streamFailed`. `connection` comes from `registry.connection` which is a single global observer in createGatewayCollections.ts — its `markOffline()`/`markUnauthorized()` are flipped by ANY transport rpc or stream (e.g. an unrelated `listRuns` poll failing). So a transient failure in a completely different collection flips this hook to `error: new Error("Run event stream failed.")` and `streaming: false` even though this run's own event WebSocket is healthy and still delivering frames. Conversely a healthy unrelated RPC immediately re-marks online, so the error flickers. The error is attributed to the wrong subject (this run's stream) rather than the global connection.

**Fix:** Derive the per-run stream health from the run's own collection state (e.g. its `live.isError`/last stream error) rather than the shared global connection observer, or expose a per-collection connection status keyed by runId.

*Verifier:* Confirmed from the actual code. createGatewayCollections.ts creates a SINGLE `const connection = createConnectionObserver()` per registry. The instrumented transport's rpc() and stream() wrappers call connection.markOnline/markOffline/markUnauthorized on ANY traffic (e.g. the `listRuns` probe in `connect`, or any pollable list collection's RPC), not per-run. The registry exposes it globally via `connection: connection.get` / `subscribeConnection`. In useGatewayRunEvents.ts L60: `streamFailed = Boolean(runId) && (connection.status === 'offline' || 'unauthorized')`, then L65-66 OR it into this run's `error` and negate it into `streaming`. So an unrelated collection's transient RPC failure flips this run's hook to error='Run event stream failed.' and streaming=false even while `live.data` (this run's own runEvents collection) is healthy and `events` still renders; a subsequent successful unrelated RPC calls markOnline and clears it, causing flicker, with the error misattributed to this run's stream. Real defect but low impact: cosmetic/spurious error banner and a false streaming=false on a healthy stream; events still populate, no crash/data loss.

### 227. [LOW · error-handling] `packages/graph/src/dom/extract.js:626`

**Timer `until` as an Invalid Date throws an opaque RangeError instead of a SmithersError**

In the Timer branch, `const until = ... untilRaw instanceof Date ? untilRaw.toISOString() : ""` (line 624-627) calls `untilRaw.toISOString()` with no validity check. If a workflow passes an invalid Date (e.g. `<Timer until={new Date("not-a-date")} />`), `Date.prototype.toISOString()` throws `RangeError: Invalid time value`, an uncaught exception that aborts the entire extraction/render rather than surfacing the intended validation error. The same pattern then powers the `hasUntil`/`exactly one of duration or until` validation (line 629-632), which never gets a chance to run. Every other invalid-input case in this function (empty worktree path, missing output, malformed timer) raises a clear `SmithersError`; this one degrades to a generic engine crash with no nodeId context.

**Fix:** Guard the conversion: `const until = typeof untilRaw === "string" ? untilRaw.trim() : (untilRaw instanceof Date && !Number.isNaN(untilRaw.getTime())) ? untilRaw.toISOString() : "";` so an invalid Date falls through to the existing `exactly one of duration or until` SmithersError (or add an explicit INVALID_INPUT check for an invalid Date).

*Verifier:* Lines 622-627: when untilRaw is `instanceof Date`, the code calls untilRaw.toISOString() with no validity check. An Invalid Date (e.g. new Date("not-a-date")) is still instanceof Date, and Date.prototype.toISOString() throws RangeError: Invalid time value on it. This uncaught RangeError fires at line 626 before the SmithersError validation at lines 630-632 can run. Every other invalid-input path in the timer branch (lines 606, 609, 616, 631, 634) throws a structured SmithersError with nodeId context, so this path is inconsistent and degrades to an opaque engine crash. Real defect, but low severity: requires the unusual input of a deliberately-invalid Date object, and it still aborts rather than silently producing wrong data.

### 228. [LOW · correctness] `packages/openapi/src/jsonSchemaToZod.js:38`

**allOf branch discards sibling type/properties/required on the same schema**

The `allOf` check (lines 38-49) runs before the `type`/`properties` handling and returns immediately, building only the intersection of the allOf sub-schemas. A schema that combines inheritance with its own fields — e.g. `{ allOf: [ {$ref:'#/.../Base'} ], type:'object', properties:{ name:{type:'string'} }, required:['name'] }`, a common OpenAPI pattern — has its own `properties`/`required` silently dropped because the function never reaches buildObject. The LLM then cannot supply (and the request never includes) those locally-declared fields.

**Fix:** When `allOf` is present alongside the schema's own `type:'object'`/`properties`, intersect the allOf result with `buildObject(s, ...)` (or merge the local properties into the combined object) instead of returning early.

*Verifier:* Confirmed. The allOf handling at lines 38-49 runs before the type/properties dispatch (lines 57-73) and returns unconditionally (return at line 42 for a single sub-schema, line 48 for the intersection). It only intersects the allOf sub-schemas and never inspects the schema's own sibling type/properties/required, so for the common OpenAPI composition pattern {allOf:[{$ref:Base}], type:'object', properties:{...}, required:[...]} the locally-declared properties/required are dropped because buildObject is never reached. Real defect; severity low since it only affects allOf-with-siblings schemas and degrades (loses fields) rather than crashing.

### 229. [LOW · error-handling] `packages/openapi/src/tool-factory/_helpers.js:226`

**Successful response with JSON content-type but empty body is reported as a tool error**

executeRequest does `const payload = contentType.includes("application/json") ? await response.json() : await response.text();` (lines 224-228). When a server returns a 2xx with `Content-Type: application/json` but an empty body (common for 200/201/202/204 side-effecting endpoints that advertise a JSON content-type), `response.json()` throws `SyntaxError: Unexpected end of JSON input`. This rejection is caught by executeToolEffect's tryPromise and surfaced to the agent as `{error:true, message:'Unexpected end of JSON input', status:'failed'}`, so a successful side-effecting call is mis-reported as a failure. The same throw also masks the real HTTP status on an error response with an empty JSON body (the `if (!response.ok)` branch on line 233 is never reached, so the agent sees a JSON-parse message instead of e.g. 'HTTP 500').

**Fix:** Read the body as text first, then `JSON.parse` only if non-empty: `const text = await response.text(); const payload = contentType.includes('application/json') && text ? safeJsonParse(text) : text;` — falling back to the raw text (and still entering the !response.ok branch) when the body is empty or unparseable.

*Verifier:* Lines 224-228: payload = contentType.includes('application/json') ? await response.json() : await response.text(). Verified at runtime: new Response('',{content-type:application/json}).json() throws 'Unexpected end of JSON input'. The parse happens before the `if (!response.ok)` check (line 233), so a 2xx side-effecting endpoint advertising JSON with an empty body is mis-reported as a tool failure, and an error response with an empty JSON body surfaces the parse error instead of the real HTTP status. No guard against empty body exists. Real but low impact (depends on servers returning empty bodies with a JSON content-type).

### 230. [LOW · concurrency] `packages/pi-plugin/src/runtime/DevToolsStore.ts:392`

**scrubTo/rewind write the fetched snapshot without re-checking runId after the await, clobbering a newly-connected run**

`scrubTo` reads `this.runId` at the start to issue `await this.client.getDevToolsSnapshot(this.runId, targetFrame)` but after the await it unconditionally writes the result into shared state:

```
const snapshot = await this.client.getDevToolsSnapshot(this.runId, targetFrame);
this.tree = snapshot.root;
this.seq = snapshot.seq;
this.mode = { kind: "historical", frameNo: snapshot.frameNo };
```

If `connect(otherRunId)` (which sets `mode = live`, resets state, and starts a new stream) runs while this fetch is in flight, the stale promise resolves afterward and overwrites the newly-connected run's `tree`/`seq` and forces `mode` back to historical for the wrong run. Unlike `applySnapshotToLiveState`, which guards `if (this.runId && snapshot.runId !== this.runId) { this.disconnect(); return false; }`, neither `scrubTo` nor the `getDevToolsSnapshot` path in `rewind` (line 446) re-validates that `this.runId` still matches the run the snapshot belongs to. Result: the inspector displays one run's tree under another run's session.

**Fix:** After the await in `scrubTo`/`rewind`, bail if `this.runId` changed (or if `snapshot.runId !== this.runId`) before mutating `tree`/`seq`/`mode`, mirroring the runId guard already present in `applySnapshotToLiveState`.

*Verifier:* Real TOCTOU in scrubTo (line 392-395): it issues await this.client.getDevToolsSnapshot(this.runId, targetFrame) then unconditionally writes this.tree = snapshot.root / this.seq / this.mode without re-checking that this.runId (or snapshot.runId) still matches. connect() (line 275) aborts only the stream (streamAbort?.abort()), not the in-flight RPC, so if connect(otherRunId) runs during the await the stale snapshot resolves and clobbers the new run's tree/seq and forces mode back to historical. Unlike applySnapshotToLiveState (line 574) which guards snapshot.runId !== this.runId and disconnects, scrubTo has no such guard -- confirmed. The rewind portion of the claim is overstated: rewind (line 446-447) routes the fetched snapshot through applySnapshotToLiveState, whose runId guard prevents the tree clobber (though rewind ignores the false return and still flips mode/requestResync). Net: scrubTo defect is genuine, recoverable transient mis-display, low severity.

### 231. [LOW · correctness] `packages/pi-plugin/src/views/Header.ts:133`

**Engine heartbeat age renders "Infinitys" when no engine heartbeat/last-event time is known**

In `render`, `engineLastMs` falls back to `this.store.lastEventAt?.getTime()` and `engineAge` is set to `Number.POSITIVE_INFINITY` when that is undefined (line 119: `const engineAge = engineLastMs === undefined ? Number.POSITIVE_INFINITY : now - engineLastMs;`). The right-hand status field then renders the engine age WITHOUT a finiteness guard:
  `` `${paint(theme, heartbeatColor(engineAge, engineHeartbeatMs), "eng")}:${Math.max(0, Math.floor(engineAge / 1_000))}s` ``
When `engineAge` is Infinity, `Math.floor(Infinity/1000)` is `Infinity`, `Math.max(0, Infinity)` is `Infinity`, so the header literally shows `eng:Infinitys`. The sandbox field on the very next line (134) DOES guard this exact case: `${Number.isFinite(sandboxAge) ? Math.max(0, Math.floor(sandboxAge / 1_000)) : "--"}s`. So the two adjacent fields are inconsistent and the engine one shows a garbage value. This happens at run start before any event arrives (lastEventAt is set to a real Date only when an event is applied, see DevToolsStore line 330) and whenever no engine-heartbeat field is present in runState.

**Fix:** Mirror the sandbox guard: `eng:${Number.isFinite(engineAge) ? Math.max(0, Math.floor(engineAge / 1_000)) : "--"}s`.

*Verifier:* Confirmed at line 133. `engineAge` is set to Number.POSITIVE_INFINITY when engineLastMs is undefined (line 119). engineLastMs = dateMs(...) ?? this.store.lastEventAt?.getTime() (lines 100-105). DevToolsStore.ts:184 initializes lastEventAt as `Date | undefined` and it is only assigned at line 330 on event apply, so before the first event and when runState has no engine heartbeat field, engineLastMs is undefined => engineAge = Infinity. Line 133 renders `:${Math.max(0, Math.floor(engineAge / 1_000))}s` with NO Number.isFinite guard, so Math.floor(Infinity/1000)=Infinity, Math.max(0,Infinity)=Infinity, producing the literal text 'eng:Infinitys'. The very next line 134 for sandbox uses `${Number.isFinite(sandboxAge) ? ... : '--'}s`, proving the inconsistency. Real cosmetic/correctness defect, low impact (display only, no crash).

### 232. [LOW · correctness] `packages/pi-plugin/src/views/NodeInspector.ts:112`

**scrollOffset can scroll past end of body, blanking the inspector content**

`handleInput` increments `this.scrollOffset += 1` on `j`/down with no upper bound (line 112), and `render` does `body.slice(this.scrollOffset, this.scrollOffset + Math.max(1, H - lines.length))` (line 166). Once `scrollOffset >= body.length`, the slice returns an empty array, so the body area shows nothing but blank padding even though content exists. There is also no clamp tied to body length, and `scrollOffset` is not reset when a different node is selected (only on tab change via the 1/2/3/[/] handlers and `g`), so switching to a shorter node can leave the pane blank. Recoverable only by pressing `k` repeatedly or `g`.

**Fix:** Clamp scrolling against body length, e.g. compute `maxOffset = Math.max(0, body.length - visibleRows)` and clamp `this.scrollOffset` in `render` (or in the `j` handler), and reset `scrollOffset` to 0 when `this.store.selectedNode` changes.

*Verifier:* Confirmed in actual code. handleInput line 112 does `this.scrollOffset += 1` on j/down arrow with no upper bound, while line 116 clamps only the lower bound (Math.max(0, ...)) on k/up. render line 166 does `body.slice(this.scrollOffset, this.scrollOffset + Math.max(1, H - lines.length))` with no clamp of scrollOffset against bodyLines length; when scrollOffset >= body.length the slice yields an empty array and only pad() blanks remain, so content disappears though it exists. scrollOffset is reset to 0 only on tab switches (handlers 1/2/3 lines 90/95/100, [ / ] / tab via nextTab line 212) and on 'g' (line 120), never on node selection (selection is driven externally via store.selectedNode), so switching to a shorter node can leave the pane blank. Recoverable via k or g. Genuine UX correctness defect, minor impact.

### 233. [LOW · logic] `packages/pi-plugin/src/views/RunTree.ts:281`

**Tree search misses matches inside collapsed subtrees**

`visibleRows()` first builds the row list with `collectRows(root, this.expandedIds, rows)`, which only recurses into a node's children when `expandedIds.has(node.id)` (lines 144-151). It then applies the search filter to that already-pruned list: `return rows.filter((row) => searchText(row.node).includes(query));` (line 281). Auto-expansion (`rebuildAutoExpansion`) only expands the root plus running/failed paths, so any completed/idle subtree stays collapsed by default. Consequently typing a query that matches a node label/agent/id living under a collapsed subtree returns ZERO rows even though the node exists in `store.tree`. The header then reads `tree 0 rows`, making the feature appear broken. A correct tree search must walk the full tree (not just expanded nodes) and reveal/expand ancestors of matches.

**Fix:** When `searchQuery` is non-empty, walk the entire tree (ignoring `expandedIds`) to collect matching nodes, e.g. compute match path ids via `collectPathIds(root, (n) => searchText(n).includes(query))` and either expand those paths or build the row list from the full traversal restricted to ancestors of matches.

*Verifier:* Confirmed. visibleRows() (L276) builds rows via collectRows, which only recurses children when expandedIds.has(node.id) (L146-150), then filters by query (L281). rebuildAutoExpansion (L312-318) only expands root + running/failed paths, so completed/idle subtrees stay collapsed and their matching descendants are absent from `rows`, yielding zero search results for nodes that exist in store.tree. Correct tree search would walk the full tree and reveal ancestors. The renderRow dim/searchMatch highlight logic (L292,296) further implies an intended in-place highlight that the L281 filter contradicts. Real functional/UX limitation, but it does not crash or corrupt data, so severity is low rather than medium.

### 234. [LOW · logic] `packages/pi-plugin/src/views/RunTree.ts:312`

**User-collapsed root is force-re-expanded on next store update**

`rebuildAutoExpansion` runs `this.expandedIds.add(root.id)` unconditionally (line 312), unlike the running/failed loop just below which respects `this.userCollapsedIds` (lines 315-318). If a user collapses the root node via `collapseSelected` (which deletes it from `expandedIds` and records it in `userCollapsedIds`), the very next render where `store.seq` changes silently re-adds the root to `expandedIds`, undoing the user's collapse. This makes root-collapse non-durable and inconsistent with every other node, whose collapse is honored.

**Fix:** Guard the root add the same way: `if (!this.userCollapsedIds.has(root.id)) this.expandedIds.add(root.id);`

*Verifier:* Confirmed. rebuildAutoExpansion runs `this.expandedIds.add(root.id)` unconditionally (L312), unlike the running/failed loop which respects userCollapsedIds (L315-318). collapseSelected can collapse root (root has children and is auto-expanded): it deletes from expandedIds and records in userCollapsedIds (L368-372). The next render where store.seq changes (guard L308) re-adds root via L312, silently undoing the collapse. Inconsistent with all other nodes whose collapse is honored. Minor UX defect, low severity.

### 235. [LOW · error-handling] `packages/react-reconciler/src/core-peer.js:13`

**importCoreModule swallows real module-evaluation errors, masking root cause**

`importCoreModule` does `try { return await import(specifier); } catch { return null; }` with an empty catch. This is meant to handle a missing peer (`@smithers-orchestrator/graph` not installed), but it ALSO swallows any error thrown while the module is being evaluated (e.g. a runtime/syntax error inside the graph package or a transitive dependency). When that happens, `resolveExtractGraph` gets `null` for both candidates and throws the generic "Unable to load extractGraph from @smithers-orchestrator/graph. Install @smithers-orchestrator/graph and ensure it exports extractGraph." The user is told to install a package that is already installed, while the actual error (the real failure inside graph) is lost, making the failure very hard to diagnose. The catch should distinguish a module-not-found resolution error from an evaluation error, or at least preserve/log the original error.

**Fix:** In importCoreModule, inspect the caught error and only treat module-not-found (e.g. err.code === 'ERR_MODULE_NOT_FOUND' / 'MODULE_NOT_FOUND' or a resolution error) as a null result; rethrow other errors. Alternatively, capture the last error and include it (err.cause) in the final 'Unable to load extractGraph' Error so the root cause is preserved.

*Verifier:* Confirmed in code lines 10-15: importCoreModule does `try { return await import(specifier); } catch { return null; }` with a bare empty catch that preserves no error. Both candidates in resolveExtractGraph (lines 22-23) go through this path, so a module-evaluation error (vs a true not-found) is indistinguishable, yielding null for both and triggering the generic throw at lines 31-32 telling the user to install an already-installed package. The original error is genuinely lost. This is a real diagnostic-masking defect, but impact is limited to debugging difficulty/misleading message, not a crash/data loss/security issue, so severity is low.

### 236. [LOW · security] `packages/sandbox/src/effect/process-runner.js:443`

**Docker `image` config is unvalidated and can inject docker run flags**

dockerArgs pushes `handle.image ?? DEFAULT_DOCKER_IMAGE` as the positional IMAGE after all flags (line 443), but image is taken straight from rawConfig.image with only `typeof === 'string'` validation (execute.js:569) — unlike env/ports/volumes/limits which are strictly validated. `docker run` parses options up to the first non-option token, so an image value beginning with `-` (e.g. `--privileged`, `-v/etc:/host-etc`, `--network=host`) is interpreted by docker as an additional flag and the intended `/bin/sh` becomes the image. A workflow that interpolates untrusted input into the `image` prop can thereby escalate container privileges or remount host paths, escaping the read-only `/workspace` isolation the runtime otherwise enforces.

**Fix:** Validate `image`: reject values starting with `-` (and ideally match a conservative `name[:tag][@digest]` pattern with no whitespace/null), or insert a `--` separator before the image positional so docker stops option parsing.

*Verifier:* Confirmed in real code. process-runner.js:443 `args.push(handle.image ?? DEFAULT_DOCKER_IMAGE, "/bin/sh", "-lc", command)` pushes the image as the positional IMAGE with no leading-dash check and no `--` options terminator. The value originates at execute.js:569 with only `typeof rawConfig.image === "string"` validation and passes untouched through SandboxTransportConfig.image -> SandboxHandle.image. This is asymmetric: env (normalizeSandboxEnv), ports (normalizeSandboxPorts/normalizePort), volumes (normalizeSandboxVolumes + assertVolumeDoesNotOverrideRuntimeMount), memoryLimit/cpuLimit (normalizeResourceLimit with regexes) are all strictly validated; image is not. docker run parses flag-looking tokens (even with interspersed parsing disabled, a `-`-prefixed token is still consumed as a flag) before binding the first non-flag positional as IMAGE, so an image value like `--privileged`, `--network=host`, or `-v/etc:/host` is interpreted by docker as an extra flag and `/bin/sh` becomes the image. Given the file's explicit isolation intent (read-only /workspace ro mount, assertVolumeDoesNotOverrideRuntimeMount, --network none), this is a genuine flag/argument-injection gap that can escalate container privileges or remount host paths. Severity adjusted to low because it is only exploitable if a workflow interpolates untrusted input into the image prop, which is uncommon, but it is a real defect, not style or a misread.

### 237. [LOW · error-handling] `packages/sandbox/src/execute.js:743`

**Failure-handling DB writes in catch can mask the original error**

The catch block awaits `adapter.upsertSandbox(...)` (line 743) and `emitSandboxEvent(runtimeDb, { type: "SandboxFailed", ... })` (line 756) before `throw error;` (line 770). If either DB/observability write rejects (e.g. DB locked, adapter error), that rejection replaces the original `error` thrown to the caller and the `SandboxFailed` event plus the failure heartbeat (lines 764-769) never run. The real cause of the sandbox failure is then lost and no failure event is recorded, hampering diagnosis of orphaned/leaked sandbox resources.

**Fix:** Wrap the upsert and emit in their own try/catch (logWarning on failure, as the finally cleanup already does) so the primary `error` is always re-thrown and the SandboxFailed event/heartbeat still fire.

*Verifier:* Real but edge-case. The catch block awaits adapter.upsertSandbox (line 743) and emitSandboxEvent SandboxFailed (line 756) before throw error (line 770). If either DB/event write rejects, that rejection replaces the original error and the SandboxFailed event + failure heartbeat (764-769) are skipped. There is no try/catch around these awaits to preserve the original error. Requires a DB/observability write to fail (e.g. locked DB) to manifest, so impact is limited, but it genuinely would mask the root cause and drop the failure event.

### 238. [LOW · correctness] `packages/scorers/src/aggregate.js:63`  _(corroborated ×3)_

**p50/stddev computed over wrong score set when a scorer_id maps to multiple scorer_names**

The SQL aggregate query groups by `GROUP BY scorer_id, scorer_name` (line 40), so `aggRows` can contain more than one row for the same `scorer_id` if that scorer's human-readable `name` ever differs across rows (e.g. a scorer keeps `id: "relevancy"` but its `name` was changed from "Relevancy" to "Answer Relevancy" between runs — `name` and `id` are independent fields on `Scorer` and nothing enforces a 1:1 mapping). However, the in-memory score grouping is keyed only by `scorer_id`: `const id = row.scorer_id; ... scoresByScorer.get(id).push(...)` (lines 56-60), and the per-row stats use `scoresByScorer.get(row.scorer_id) ?? []` (line 63). Result: every aggRow that shares a scorer_id receives the COMBINED set of all scores for that id, so `p50 = computeMedian(scores)` and `stddev = computeStddev(scores, mean)` are computed over the union of all names while `count/mean/min/max` are the correct per-(id,name) values from SQL. The stddev is especially wrong because it mixes the per-name SQL `mean` (line 65) with the combined-name `values` array, producing nonsensical variance. The aggregate report then shows internally inconsistent statistics.

**Fix:** Key the in-memory grouping by the same composite the SQL groups by. Either change the GROUP BY to `scorer_id` only (and pick a representative name via MAX/MIN(scorer_name)), or include `scorer_name` in `scoresQuery` and build the map keyed by `scorer_id + ' ' + scorer_name`, looking it up the same way in the `aggRows.map`.

*Verifier:* Confirmed in code: aggQuery (line 40) `GROUP BY scorer_id, scorer_name` emits one row per (id,name) pair, but scoresByScorer (lines 55-60) is keyed by scorer_id alone, and line 63 fetches `scoresByScorer.get(row.scorer_id)`. So if one scorer_id ever has two scorer_name values, every aggRow with that id receives the union of all scores for p50/stddev while count/mean/min/max are the per-(id,name) SQL values. computeStddev(scores, mean) (line 66) then mixes the per-name SQL mean with the union values array, producing inconsistent variance. The mismatch is genuinely present. Confirmed scorer_id and scorer_name are independent free-form columns (smithersScorers.js, createScorer.js) persisted verbatim per row (run-scorers.js:208-209) with no 1:1 enforcement, so the edge case is reachable (e.g. two bindings sharing an id with different names, or a rename across aggregated runs). Severity is low because in the overwhelmingly common 1:1 id->name case there is exactly one aggRow per id and the result is correct; impact is limited to a read-only aggregate report and only under the rename/duplicate-id edge case.

### 239. [LOW · data-loss] `packages/server/src/gateway.js:325`

**runs.rerun drops non-object webhook payloads, producing empty input**

`normalizeRerunInput` (lines 321-334) reconstructs the input for `runs.rerun` (called at line 5310 via `loadInput`). When the stored input row has a `payload` key it does:

```js
if ("payload" in row) {
  const { runId: _runId, payload, ...rest } = row;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return { ...payload, ...rest };
  }
  return rest;
}
```

The `payload` wrapper is exactly how `normalizeWebhookRunInput` (line 1266) stores a webhook body that is NOT a plain object: `const normalized = asObject(input) ?? { payload: input ?? null };`. So a webhook triggered with a JSON string, number, boolean, or array body is persisted as `{ payload: <value> }`. On rerun, the branch checks `payload && typeof payload === "object" && !Array.isArray(payload)` — which is FALSE for strings/numbers/booleans and for arrays — so it falls through to `return rest`, where `rest` is `{}` (runId and payload both destructured out). The payload value is silently discarded and the run is recreated with empty input `{}` instead of the original `{ payload: <value> }`. This corrupts/loses the rerun's input for every webhook run whose original body was a non-object or array, causing the rerun to behave differently from the original (wrong results or a validation failure).

**Fix:** Preserve the payload when it is not a plain object so the original wrapper is reproduced: replace `return rest;` (the inner fallback inside the `"payload" in row` branch) with `return { payload, ...rest };` so non-object/array payloads round-trip as `{ payload: <value> }`, matching what `normalizeWebhookRunInput` originally produced.

*Verifier:* Confirmed at lines 321-334. normalizeWebhookRunInput (1267) wraps non-object webhook bodies as {payload:value}; startRun persists that. loadInput (db/snapshot.js:103) JSON-parses a `payload` column back. normalizeRerunInput's payload branch only merges when payload is a non-array object; for a string/number/boolean/array it destructures payload out and returns `rest`={}, silently dropping the value on rerun. Genuine data loss, but narrow: requires a webhook run with a scalar/array body, a `payload` input column, and a subsequent rerun.

### 240. [LOW · security] `packages/server/src/gateway.js:981`  _(corroborated ×2)_

**JWT signature check uses non-constant-time string compare, defeating the timingSafeEqual that follows**

In `verifyJwtToken` the signature is compared first with a plain string equality that short-circuits:
```js
const expectedSignature = createHmac("sha256", config.secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
if (encodedSignature !== expectedSignature) {
    return { ok: false, message: "JWT signature verification failed" };
}
const actualSignature = Buffer.from(encodedSignature, "base64url");
const expectedSignatureBuffer = Buffer.from(expectedSignature, "base64url");
if (actualSignature.length !== expectedSignatureBuffer.length ||
    !timingSafeEqual(actualSignature, expectedSignatureBuffer)) {
    return { ok: false, message: "JWT signature verification failed" };
}
```
The `encodedSignature !== expectedSignature` branch (line 981) does an early-exit, byte-position-dependent JavaScript string comparison. Any token whose signature mismatches is rejected here, so the subsequent `timingSafeEqual` (lines 984-989) is only ever reached when the strings are already exactly equal, making the constant-time comparison dead code. The non-constant-time `!==` leaks how many leading characters of a forged signature matched the expected HMAC, which is exactly the side channel `timingSafeEqual` was added to prevent. The same pattern was deliberately avoided in `isValidWebhookSignature` (which only uses length-check + timingSafeEqual), so this is an inconsistency and a regression of the timing-safe intent.

**Fix:** Remove the early `if (encodedSignature !== expectedSignature)` string comparison and rely solely on the length check plus `timingSafeEqual` on the decoded buffers (or compare the base64url strings via timingSafeEqual on their utf8 buffers after a length guard), so signature comparison is constant-time.

*Verifier:* verifyJwtToken line 981 does `if (encodedSignature !== expectedSignature) return ...` (variable-time string compare, short-circuits) BEFORE the timingSafeEqual at 986-987. The timingSafeEqual only runs when strings are already byte-identical, so it is dead code and the actual comparison is the non-constant-time !==. isValidWebhookSignature (1251-1261) correctly uses only length-check + timingSafeEqual, confirming the intended pattern is violated here. Low real-world exploitability over a network but a genuine regression of the timing-safe intent.

### 241. [LOW · security] `packages/server/src/gateway.js:1298`

**Empty subscribe Set leaks all run events on broadcast channel (contradicts devtools auth contract)**

`shouldDeliverEvent` (used by `broadcastEvent` at line 3700-3704 to gate the legacy `run.*` event channel) treats an empty subscribedRuns Set as "no filter": `if (!connection.subscribedRuns || connection.subscribedRuns.size === 0) return true;`. But `isDevToolsRunAuthorized` (line 1759-1770, in-slice) documents and enforces the OPPOSITE contract for the very same field: "A Set means a `subscribe` filter WAS provided... An explicitly-empty Set therefore denies every run" — it does `return connection.subscribedRuns.has(runId)` with no size-0 escape. An empty Set is reachable: the connect handler at line 3269 does `connection.subscribedRuns = Array.isArray(request.subscribe) ? new Set(request.subscribe.filter(v => typeof v === 'string')) : null`, so a client connecting with `subscribe: []` (or a list whose entries are all non-strings) gets an empty Set. The devtools path then correctly denies all runs, but the broadcast event channel (`shouldDeliverEvent`) DELIVERS every run's events to that connection. A client that explicitly scoped its subscription to nothing still receives all run events of all runs, an authorization/scoping gap and information disclosure.

**Fix:** Make `shouldDeliverEvent` agree with `isDevToolsRunAuthorized`: drop the `|| connection.subscribedRuns.size === 0` clause so a present (even empty) Set is treated as an allow-list (`return connection.subscribedRuns.has(runId)`). Use `null`/`undefined` as the only "unrestricted" sentinel.

*Verifier:* shouldDeliverEvent (1295-1302) returns true when subscribedRuns is empty (size===0), while isDevToolsRunAuthorized (1759-1770) returns has(runId) with no size-0 escape (empty Set denies all). Connect handler (3273-3275) makes subscribe:[] an empty Set. broadcastEvent (3704) gates on shouldDeliverEvent, so a subscribe:[] connection still receives every run's events on the legacy channel while the devtools path denies all. Real inconsistency with the documented contract; severity low because the connection is already authenticated and scopes still gate actual access (subscribe is a delivery filter).

### 242. [LOW · resource-leak] `packages/server/src/gateway.js:1942`

**drainRunEventStream clears flushPending in finally during backpressure retry, allowing pile-up of retry timers**

In `drainRunEventStream`, when the socket is congested the code schedules `setTimeout(() => { stream.flushPending = false; this.drainRunEventStream(...) }, RUN_EVENT_STREAM_DRAIN_RETRY_MS)` and `return`s from inside the `try`. The `finally { stream.flushPending = false; }` then runs immediately on that return, clearing the re-entrancy guard during the retry wait window. So while waiting for the socket to drain, any newly arriving frame calls `sendRunEventStreamFrame` -> `drainRunEventStream`, which (flushPending now false) enters, sees the socket still congested, and schedules ANOTHER retry timer. Under sustained congestion plus a steady frame rate this accumulates multiple concurrent retry timers (the guard never holds across the wait). It is bounded by the outbound queue cap that eventually trips the backpressure disconnect, and frames are still sent in FIFO order (no reorder/dup), so impact is limited to redundant timers/wakeups.

**Fix:** Do not clear flushPending in the finally on the congestion-retry path; only the scheduled timer callback should reset it. e.g. set a local `rearmed` flag before `return` and guard the finally, or restructure so flushPending stays true until the retry timer fires.

*Verifier:* drainRunEventStream (1917-1945): on congestion it schedules setTimeout(...flushPending=false; redrain...) and returns inside the try, but the finally (1942-1944) immediately sets flushPending=false. During the 10ms retry window the single-flight guard is off, so new frames re-enter drainRunEventStream and schedule additional retry timers, piling up. Bounded by the queue cap → backpressure disconnect; no frame loss/reorder. Minor wasted timers as claimed.

### 243. [LOW · error-handling] `packages/server/src/gateway.js:2316`

**Webhook secret deref throws on undefined/null, defeating the intended 'secret not configured' guard**

`const secret = webhook.secret.trim();` (line 2316) runs BEFORE the `try` block (which starts at 2328) and BEFORE the guard `if (!secret) { return reject(500, ... 'Webhook secret is not configured' ...) }` (lines 2317-2318). The author clearly intends to return a clean 500 when the secret is missing, but if `webhook.secret` is `undefined` or `null` (a realistic case since secrets are commonly sourced from env, e.g. `secret: process.env.WEBHOOK_SECRET` which is `undefined` when unset), `.trim()` throws a TypeError. handleWebhook is invoked as `return this.handleWebhook(...)` inside the `createServer(async (req,res)=>{...})` callback, so the throw becomes an unhandled promise rejection and the HTTP response is never written — the client hangs until `requestTimeout` instead of receiving the intended 500. The empty-string guard at 2317 only covers `''`, not the undefined/null case it was meant to backstop.

**Fix:** Use optional chaining / coalescing before the guard: `const secret = (webhook.secret ?? '').trim();` (or move the trim inside the try block) so a missing secret yields the intended 500 reject rather than an unhandled rejection and hung request.

*Verifier:* Line 2316 `const secret = webhook.secret.trim();` runs before the guard at 2317 and before the try at 2328. If webhook.secret is undefined/null, .trim() throws synchronously; handleWebhook is returned (not awaited in try/catch) from the createServer async listener (2458/2479), so Node does not write a response and the client hangs until requestTimeout. The guard's 'Webhook secret is not configured' message shows the author intended to handle a missing secret, but it only catches ''. The type declares secret:string so triggering needs a type-violating/env-sourced caller, hence low severity.

### 244. [LOW · security] `packages/server/src/gateway.js:3476`

**Electric write endpoint skips assertJsonPayloadWithinBounds applied on every other RPC path**

In handleElectricWrite the body is read with `const body = asObject(await readBody(req, this.maxBodyBytes));` and then `params = body.params ?? body.vars ?? {}` is forwarded straight into the RPC frame and executeRpc/routeRequest. Unlike the two other gateway entry points, this path never calls `assertJsonPayloadWithinBounds`. The WS frame parser (parseGatewayRequestFrame, line 734) and the HTTP RPC handler (handleHttpRpc, line 3615) both enforce `assertJsonPayloadWithinBounds("gateway frame", body, { maxArrayLength: GATEWAY_RPC_MAX_ARRAY_LENGTH, maxDepth: GATEWAY_RPC_MAX_DEPTH, maxStringLength: GATEWAY_RPC_MAX_STRING_LENGTH })` as defense-in-depth against deeply-nested / huge-array / huge-string payloads. The Electric write path bypasses those structural limits entirely (only the raw byte cap from readBody applies), so an authenticated caller can submit payloads with unbounded nesting depth or array length that every other transport rejects, reaching recursive processing / per-method handlers with structures the rest of the gateway guarantees against.

**Fix:** After parsing the body in handleElectricWrite, call `assertJsonPayloadWithinBounds("gateway frame", body, { maxArrayLength: GATEWAY_RPC_MAX_ARRAY_LENGTH, maxDepth: GATEWAY_RPC_MAX_DEPTH, maxStringLength: GATEWAY_RPC_MAX_STRING_LENGTH })` before building the frame, matching handleHttpRpc.

*Verifier:* handleElectricWrite (3480) reads body via readBody and never calls assertJsonPayloadWithinBounds, whereas parseGatewayRequestFrame (734) and handleHttpRpc (3619-3623) both enforce maxArrayLength/maxDepth/maxStringLength. Downstream validateGatewayRpcInput only checks total bytes + depth and only for input-validating methods, so array-length and string-length structural caps are bypassed on this path. Real defense-in-depth gap; severity low because the 1MB byte cap from readBody still applies and the path requires auth+scope.

### 245. [LOW · error-handling] `packages/server/src/gateway.js:3539`

**Electric write catch ignores SmithersError code and infers status from message substrings**

The handleElectricWrite catch block builds the error response purely from message string matching: `const message = error?.message ?? "Electric write failed"; const status = message.includes("valid JSON") ? 400 : message.includes("exceeds") ? 413 : 500;`. Unlike handleHttpRpc (line 3648) it never checks `isSmithersError(error)` to honor `error.code`/`statusForRpcError`. So a client error like an invalid method name — `validateGatewayMethodName` throws SmithersError("INVALID_INPUT", "Gateway method name is invalid.") — has a message containing neither 'valid JSON' nor 'exceeds', so it is reported as HTTP 500 SERVER_ERROR instead of a 4xx client error, and the real error code is dropped from the response envelope. Substring matching is also fragile: an unrelated SmithersError whose message happens to contain 'exceeds' would be mislabeled PAYLOAD_TOO_LARGE/413.

**Fix:** Mirror handleHttpRpc: if `isSmithersError(error)` return `sendJson(res, statusForRpcError(error.code), { ok:false, code: error.code, message: error.summary })` before falling back to the message-substring heuristic.

*Verifier:* handleElectricWrite catch (3543-3556) derives status purely from message substrings ('valid JSON'->400, 'exceeds'->413, else 500) and never checks isSmithersError(error)/error.code, unlike handleHttpRpc (3652-3653). A SmithersError like INVALID_INPUT from validateGatewayMethodName is reported as 500 SERVER_ERROR and its code is dropped. Note the same block already uses isSmithersError(error) for log level (3544) but not for status, confirming the oversight. Low impact (wrong status codes on one path).

### 246. [LOW · performance] `packages/server/src/gateway.js:5660`

**flushPending reset in finally defeats single-flight drain guard under backpressure**

In `drainOutboundQueue`, when the socket is backpressured the code schedules a retry timer and returns from the microtask: `setTimeout(() => { flushPending = false; drainOutboundQueue(); }, 10); return;` (lines 5649-5653). Because the `return` is inside the `try`, the `finally { flushPending = false; }` (lines 5660-5662) still executes immediately, clearing the single-flight guard even though a retry timer is already pending. Any `send()` call during the 10ms window (lines 5722-5723) then sees `flushPending === false`, proceeds, observes the still-high buffer, and schedules ANOTHER setTimeout. Under sustained backpressure with frequent sends this accumulates redundant timers (up to ~EXTENSION_STREAM_OUTBOUND_QUEUE_LIMIT of them) all firing every 10ms, wasting CPU. No frames are lost or reordered (the queue is shift-drained), so impact is limited to a mild timer/CPU storm bounded by the queue limit.

**Fix:** Do not reset `flushPending` in the backpressure branch. Either move the `flushPending = false` out of `finally` and set it only on the normal drain-complete path, or guard the retry so it doesn't double-schedule (e.g. keep flushPending true while a retry timer is outstanding and clear it inside the timer callback).

*Verifier:* drainOutboundQueue (5652-5675): on backpressure it schedules setTimeout(...flushPending=false; drainOutboundQueue,10) and returns from the microtask inside the try, but finally (5671-5673) sets flushPending=false immediately. During the 10ms window send() (5734) re-enters with flushPending false and schedules another timer; redundant timers accumulate under sustained backpressure. Bounded by EXTENSION_STREAM_OUTBOUND_QUEUE_LIMIT and no frame loss/reorder, so low-impact CPU/timer waste as claimed.

### 247. [LOW · api-misuse] `packages/server/src/GatewayExtensions.js:244`

**Namespace named "stream" makes its resources/actions permanently unreachable**

`register()` validates a namespace only against `EXTENSION_IDENTIFIER_PATTERN` (`/^[a-z][a-zA-Z0-9_-]*$/`), so the namespace `"stream"` is accepted and stored. But `resolve(method)` dispatches on the prefix before the namespace is parsed: `if (method.startsWith(EXTENSION_STREAM_METHOD_PREFIX))` where `EXTENSION_STREAM_METHOD_PREFIX = "ext.stream."`. A resource/action registered under namespace `"stream"` is addressed as `ext.stream.<key>` (per `extensionMethodName`, which produces `${EXTENSION_METHOD_PREFIX}${namespace}.${key}` = `ext.stream.<key>`). That string matches the stream prefix, so resolve takes the stream branch: `rest = method.slice(11)` = `"<key>"`, `splitAt = rest.indexOf(".")` = -1, hits `if (splitAt <= 0 ...) return undefined`. The resource/action therefore never resolves and the gateway returns EXTENSION_METHOD_NOT_FOUND, even though registration succeeded silently. `requiredScopeForMethod` (line 310) also returns undefined for it. The namespace is effectively a reserved word but is not rejected, so an extension author who picks `"stream"` ships a surface that can never be invoked.

**Fix:** Reject the reserved namespace `"stream"` in `assertExtensionIdentifier`/`register` (throw INVALID_INPUT), or have `resolve()` confirm the stream branch actually parsed a namespace+key and otherwise fall through to the resource/action branch.

*Verifier:* Confirmed from code. register() (line 185-186) validates namespace only against EXTENSION_IDENTIFIER_PATTERN/length; 'stream' matches /^[a-z][a-zA-Z0-9_-]*$/ so it is accepted, with no reserved-word guard. extensionMethodName('stream','resource',key) (line 359-366) yields 'ext.stream.<key>'. resolve() (line 243-267) checks method.startsWith('ext.stream.') (line 247) BEFORE parsing the namespace, so 'ext.stream.<key>' takes the stream branch: rest='<key>', splitAt=indexOf('.')=-1 (keys cannot contain dots per the identifier pattern), line 250 returns undefined. Thus resources/actions registered under namespace 'stream' never resolve and requiredScopeForMethod (line 310) returns undefined, causing EXTENSION_METHOD_NOT_FOUND despite successful registration. Streams under 'stream' still work (ext.stream.stream.<key> splits correctly), matching the claim's scope. Genuine footgun; severity low because it is author-controlled config and not a security/data-loss issue.

### 248. [LOW · performance] `packages/server/src/gatewayRoutes/getDevToolsSnapshot.js:414`

**Requesting an old frame inflates the entire frame window into memory**

When a non-latest frame is requested, the route does `(await input.adapter.listFrames(runId, Math.max(latestFrame.frameNo - requestedFrameNo + 1, 50))).find((entry) => entry.frameNo === requestedFrameNo)`. `listFrames` (adapter.js:2593) selects up to `limit` rows ordered `frame_no DESC` and calls `inflateFrameRow` on every one of them (reconstructing delta-encoded frames against the keyframe), building an `expanded` array of fully-inflated frames. For a run with many frames, requesting a low `requestedFrameNo` makes `limit` = `latestFrame.frameNo - requestedFrameNo + 1`, so the handler loads and reconstructs the entire window (potentially the whole run's frame history) into memory just to pull out one target frame. The result is correct but the cost scales with the distance from the latest frame, creating avoidable memory pressure / latency on large runs.

**Fix:** Add an adapter method to fetch a single frame by exact frameNo (SELECT ... WHERE run_id = ? AND frame_no = ? plus delta reconstruction), and use it here instead of listing and inflating the whole window.

*Verifier:* Confirmed at getDevToolsSnapshot.js:412-414. For a non-latest frame the route calls input.adapter.listFrames(runId, Math.max(latestFrame.frameNo - requestedFrameNo + 1, 50)) then .find()s the one matching frameNo. listFrames (adapter.js:2593-2609) selects up to `limit` rows (ORDER BY frame_no DESC LIMIT ?) and runs inflateFrameRow on EVERY row (line 2606), each reconstructing delta-encoded frames against the keyframe via reconstructFrameXml. So a low requestedFrameNo sets limit to the full distance-from-latest, inflating the whole window in memory to extract one frame. The cost/memory scales with distance from latest, and it is avoidable: adapter.reconstructFrameXml(runId, frameNo) (adapter.js:1508) can reconstruct a single frame directly, bounded by the keyframe interval. Output is correct, so this is a genuine but minor performance/memory inefficiency, not a correctness/crash/leak/security bug; severity low.

### 249. [LOW · correctness] `packages/server/src/gatewayRoutes/getNodeDiff.js:584`

**summarizeBundle undercounts diff lines whose content starts with '--' or '++'**

In summarizeBundle, a line is skipped as a file header whenever its first two/three chars are '++'/'--':

```
if (ch === 43 /* + */ && !(text.charCodeAt(cursor + 1) === 43 && text.charCodeAt(cursor + 2) === 43)) { added++; }
else if (ch === 45 /* - */ && !(text.charCodeAt(cursor + 1) === 45 && text.charCodeAt(cursor + 2) === 45)) { removed++; }
```

This heuristic does not distinguish the one-time unified-diff file headers (`--- a/path`, `+++ b/path`) from genuine content lines whose text happens to begin with `-`/`+`. Removing a source line whose content is `-foo` yields the diff line `--foo` (skip-condition false -> counted, fine), but a content line `--foo` yields `---foo`, and an added content line `++bar` yields `+++bar`; both are wrongly treated as headers and dropped from the added/removed counts. The reported summary (added/removed) is therefore an undercount for files containing such lines.

**Fix:** Only treat the literal file-header forms as headers by tracking hunk state: count +/- lines only when inside an `@@` hunk, and exclude `--- ` / `+++ ` (with trailing space) explicitly rather than any line beginning with two markers.

*Verifier:* In summarizeBundle the skip guard treats any line whose first three chars are +++ or --- as a header. A genuine added content line whose text starts with ++ becomes the diff line +++... (charCodeAt+1===43 && +2===43 -> dropped); a removed content line starting with -- becomes ---... (dropped). The claim's -foo example (--foo) is indeed still counted (charCodeAt+2 is 'f', not 45). So added/removed are undercounted for files with content lines beginning with ++ or --. Real but rare edge case, only on the stat/summary path; low severity.

### 250. [LOW · correctness] `packages/server/src/gatewayRoutes/getNodeOutput.js:193`

**Legitimate top-level array output is rejected as MalformedOutputRow**

For a single-JSON-column ('payload') output table, `normalizeOutputRow` returns `r.payload` verbatim (lines 438-443). If a node's output payload is a valid JSON array, `normalizedRow` is an array, and the guard at line 193 `if (normalizedRow !== null && !isPlainObject(normalizedRow))` throws `NodeOutputRouteError('MalformedOutputRow', 'Output row must be a JSON object or null.')` because `isPlainObject` explicitly excludes arrays (`!Array.isArray(value)` at line 496). So a node that legitimately produced a top-level array result cannot be fetched through this route (e.g. `smithers output --pretty <node>` errors), even though the data is well-formed JSON. The default `--json` path bypasses the route, masking this for the common case but not for the pretty/devtools path.

**Fix:** Allow array payloads: either widen the accepted shape to objects, arrays, and primitives (the NodeOutputResponse.row type would need to widen too), or wrap non-object payloads instead of throwing, so valid array/scalar outputs are returned rather than reported as malformed.

*Verifier:* Confirmed from the real code. normalizeOutputRow (lines 438-443) returns `r.payload ?? null` verbatim for a payload-only table (a table whose keys are only runId/nodeId/iteration/payload). selectOutputRowEffect.js returns the raw drizzle row; the payload column is `text(..., {mode:'json'})` (engine/effect/builder.js:85, smithers/create.js:166) so its parsed value can be ANY JSON value, including a top-level array. Payload-only tables are really created: createPayloadTable in packages/engine/src/effect/builder.js is used for EVERY builder step() and approval() (lines 131, 156), and a step's `output` schema is an arbitrary zod schema (e.g. z.array(...)). When such a step produces an array, normalizedRow is an array, and the guard at line 193 `if (normalizedRow !== null && !isPlainObject(normalizedRow))` fires because isPlainObject (line 495-496) excludes arrays via `!Array.isArray(value)`, throwing NodeOutputRouteError('MalformedOutputRow', 'Output row must be a JSON object or null.'). So well-formed JSON array output is rejected as malformed through this gateway route. The NodeOutputResponse.ts type even declares `row: Record<string, unknown> | null`, confirming arrays were never accommodated. Severity is low: it is an edge case (top-level array outputs are uncommon; multi-column zodToTable outputs are always objects), affects only the gateway/DevTools/pretty route path, and the misleading error is the visible symptom rather than data loss. Confidence medium because reachability requires the builder payload-table path combined with an array-typed output schema.

### 251. [LOW · data-loss] `packages/server/src/gatewayRoutes/streamDevTools.js:141`

**AsyncEventQueue.next() discards already-buffered valid events when the producer errors**

In `next()` the order of checks is:
```js
async next() {
    if (this.error) { throw this.error; }
    if (this.items.length > 0) { ... return { value, done:false }; }
    if (this.closed) { return { value: undefined, done: true }; }
```
The error check precedes the buffered-items check, whereas `close()` is handled AFTER items are drained. So the two terminal paths behave asymmetrically: `close()` lets the consumer drain everything already queued (graceful), but `fail()` makes the very next `next()` throw and discard any events still sitting in `this.items`.

Concrete scenario: while the consumer is busy (no waiter registered), the producer successfully `publish()`es events A, B, C into `queue.items`, then on the next frame `captureSnapshot()`/`makeEvent()` throws and the producer catch calls `queue.fail(error)` (streamDevTools.js:512). The consumer's subsequent `await queue.next()` (line 523) immediately throws, so the already-serialized valid events A, B, C are never yielded. The client receives the error instead of the buffered frames. The devtools client recovers by resubscribing with its last seq, so impact is bounded, but valid in-flight events are dropped rather than delivered-then-errored.

**Fix:** Drain buffered items before surfacing the error, mirroring the close() path: check `this.items.length > 0` first and only throw `this.error` once items are empty. e.g.
```js
async next() {
  if (this.items.length > 0) { return { value: this.items.shift(), done: false }; }
  if (this.error) { throw this.error; }
  if (this.closed) { return { value: undefined, done: true }; }
  ...
}
```

*Verifier:* Confirmed exactly in code: next() checks `if (this.error) throw this.error` at line 141 BEFORE draining `this.items` at line 144, whereas the closed terminal check at line 148 comes AFTER the items drain. So close() lets the consumer drain buffered events while fail() throws immediately and discards them. Reachable: producer publish()->queue.push() (line 241/112) buffers into this.items whenever no consumer waiter is registered (which happens while the generator is suspended at the yield on line 528 awaiting a slow downstream consumer, e.g. a backpressured WebSocket). If captureSnapshot/makeEvent then throws, the producer catch calls queue.fail(error) at line 512 with events still in this.items; the consumer's subsequent queue.next() at line 523 throws at line 141 and those buffered frames are never yielded. The asymmetry vs close() is genuine. Severity is low: the dropped frames are transient and the devtools client recovers by resubscribing with its last seq against the DB-backed replay path, so there is no permanent data loss.

### 252. [LOW · correctness] `packages/server/src/gatewayUi/defaultOperatorUi.js:642`  _(corroborated ×2)_

**JSON truncation marker renders a literal backslash-n instead of a newline**

formatJson returns `text.slice(0, limit) + "\\n... truncated ..."` (line 642). The byte sequence is backslash-backslash-n, so the JS string literal evaluates to a literal backslash followed by 'n' (\n as text), not a newline character. Because the truncated JSON is shown inside `<pre class="code">` (white-space: pre-wrap) where a real newline would break the line, large node outputs/diffs display `...}\n... truncated ...` with a visible `\n` artifact glued to the JSON instead of a clean line break. The double escaping is wrong whether the function runs directly or via its .toString() serialization (DEFAULT_OPERATOR_UI_CLIENT_JS); both paths produce the same literal.

**Fix:** Use a single-escaped newline: `text.slice(0, limit) + "\n... truncated ..."`.

*Verifier:* Line 642: `text.slice(0, limit) + "\\n... truncated ..."` — the source contains two backslashes. The function is serialized via .toString() (toString returns literal source, no escape processing) and embedded in a template literal, so the browser parses `\\n` as escaped-backslash + 'n', yielding the two characters backslash+n at runtime, not a newline. Rendered inside <pre> after escapeText, it displays a literal `\n` artifact instead of a line break. Minor cosmetic, only triggers for >3600-char output.

### 253. [LOW · resource-leak] `packages/server/src/gatewayUi/defaultOperatorUi.js:923`

**DevTools WebSocket not closed on terminal devtools.error when retry is declined**

In the startDevToolsStream onEvent handler, the `devtools.error` branch calls `if (retryDevToolsStream(...)) return;` (line 920). retryDevToolsStream only closes the connection on the retry path (line 865). When retry is declined (attempt>=5 or message not matching /not found|closed|failed/), control falls through to lines 923-925 which set status "Error" and render but never call connection.close(). The underlying WebSocket stays open in an Error state until the user switches runs (closeRunStreams). Contrast with the catch block at line 943 which does `if (connection) connection.close()` on the same non-retry outcome.

**Fix:** In the devtools.error non-retry branch, call connection.close() (and clear state.streams.devtools) before setting the Error status, mirroring the catch block at line 943.

*Verifier:* In the devtools.error branch (918-926), when retryDevToolsStream returns false it falls through to set status 'Error' and render but never calls connection.close(); retryDevToolsStream only closes on the retry path (865). The catch block at 943 does `if (connection) connection.close()` for the same non-retry outcome, confirming the omission. The socket stays open in Error state until closeRunStreams runs (run switch / refresh dropping the run via state.streams.devtools at 932), so it is a bounded leak. Real but minor.

### 254. [LOW · error-handling] `packages/server/src/gatewayUi/defaultOperatorUi.js:1005`

**Run-events stream never reconnects, so the chronicle silently dies after a socket drop**

startDevToolsStream has retry/reconnect logic (retryDevToolsStream, lines 861-875, invoked on error/close-like messages). startRunEventsStream (lines 1005-1042) has NO equivalent: on a `client.close` frame it only sets `state.eventsStatus = ... "Closed"` (line 1012) and on `client.error` sets "Error" (line 1017), never re-subscribing. For a long-running workflow whose run-events WebSocket drops (network blip, idle timeout), the heartbeat and run.event chronicle simply stop updating with no recovery, while the DevTools tree keeps reconnecting. The operator sees a stale 'Closed' chronicle and may assume the run stopped emitting events.

**Fix:** Mirror the DevTools retry path: on client.close / client.error for a still-current stream, schedule a backoff reconnect via setTimeout guarded by streamStillCurrent(runId, generation), re-subscribing with streamRunEvents (using state.runEventSeq as afterSeq to avoid replaying the whole history).

*Verifier:* startRunEventsStream (1005-1042) only sets state.eventsStatus to 'Closed'/'Error' on client.close/client.error (1011-1021) and never resubscribes; there is no retry helper analogous to retryDevToolsStream. After a run-events socket drop the chronicle/heartbeat stop updating with no recovery until the operator reselects the run. Confirmed in code.

### 255. [LOW · concurrency] `packages/server/src/index.js:628`

**Mirror event persistence is fully detached per-event, allowing out-of-order writes and a stale final run status**

`buildMirrorOnProgress` returns `(event) => { void runPromise(mirrorEventEffect(event)).catch(...) }` (lines 628-637). Each event from the engine spawns an independent, unsequenced promise. `mirrorEventEffect` awaits `ensureRun()` and then `insertEventWithNextSeq` + a status `updateRun` (lines 453-621). Because the per-event effects run concurrently with internal awaits, their DB writes can interleave/reorder relative to engine emission order. `insertEventWithNextSeq` assigns the event seq at execution time, so the mirror DB can store events out of emission order (SSE consumers reading the mirror by seq then deliver them wrongly), and the run-status updates can land out of order, e.g. RunStarted's `updateRun({status:'running'})` resolving AFTER RunFinished's `updateRun({status:'finished'})`, leaving the mirrored run permanently in 'running'. This affects the serverDb mirror path (serverAdapter && !sameDb), which backs gateway/ps reads in shared-DB mode.

**Fix:** Serialize mirror writes per run: chain each event's effect onto a per-run promise tail (or use a single queue/fiber) so events are persisted in emission order rather than racing via independent detached promises.

*Verifier:* buildMirrorOnProgress returns a fire-and-forget callback `(event)=>{ void runPromise(mirrorEventEffect(event)).catch(...) }` (628-637) with no per-event sequencing. mirrorEventEffect suspends at ensureRun (Effect.tryPromise) and then insertEventWithNextSeq/updateRun. For async DB backends (PGlite/Postgres) fibers can interleave at those suspension points, so seq assignment and status updates can land out of emission order. The mechanism is real for the serverDb mirror path (serverAdapter && !sameDb). However the headline 'permanently stuck in running' is unlikely: RunStarted fires at run start and RunFinished at run end, far apart in time, so their fibers won't realistically reorder; and for synchronous bun:sqlite the post-suspension work runs to completion per fiber in creation order, preserving order. Real but lower impact than claimed.

### 256. [LOW · concurrency] `packages/server/src/index.js:718`  _(corroborated ×2)_

**TOCTOU on client-supplied runId allows two workflows to start on the same runId/DB**

In `POST /v1/runs`, when the client supplies `body.runId` (line 718), the duplicate check is `const existing = await adapter.getRun(runId)` followed later by `runs.set(runId, record)` and `runWorkflow(...)` (lines 720-751). Two concurrent requests with the same `runId` can both observe `existing === null`, both pass the `409 RUN_ALREADY_EXISTS` guard, both `runs.set` (the second overwriting the first record and orphaning its AbortController), and both launch `runWorkflow` against the same DB, racing writes to the same run rows and leaking the first run's abort handle.

**Fix:** Reserve the runId atomically (e.g. insert the run row up front under a uniqueness constraint and treat a conflict as 409) before launching runWorkflow, rather than relying on a read-then-act check; also refuse to overwrite an existing in-memory record for the same runId.

*Verifier:* Real TOCTOU. POST /v1/runs reads `existing = await adapter.getRun(runId)` (720) then later runs.set + Effect.runPromise(runWorkflow) (744,751) with no lock between the await and the insert. Two concurrent requests with the same client-supplied body.runId can both observe existing===null, both pass the 409 guard, and the second runs.set overwrites the first record (orphaning its AbortController). The engine's run-row insert likely has a unique key that makes the second runWorkflow fail, but the in-memory record overwrite/abort orphaning is real. Narrow trigger (client must reuse runId concurrently), low impact.

### 257. [LOW · correctness] `packages/server/src/serve.js:196`

**SSE /events can terminate before the final event if status is written before the terminal event**

The stream breaks when `runRow` is terminal AND `events.length === 0`:
```js
if (runRow && ["finished","failed","cancelled","continued"].includes(runRow.status) && events.length === 0) break;
```
This assumes the run's terminal status row is always persisted strictly after the last event row. If the engine ever updates `runs.status` to a terminal value before inserting the final RunFinished/RunFailed event (or in a separate transaction with the status committed first), a poll iteration can observe terminal status with zero new events and break, dropping the trailing event from the SSE stream. Whether this fires depends on engine write ordering; flagged as a latent ordering dependency.

**Fix:** Before breaking on terminal status, do one final `listEvents` pass and only break when that final pass also returns zero events, or have the engine guarantee the terminal event is committed before the terminal status.

*Verifier:* The ordering dependency the claim hinges on is satisfied by the engine: in all terminal paths the status is committed before the final event is emitted - finished at engine.js:5469 updateRun(status:'finished') then 5484 emitEventWithPersist(RunFinished); failed at 5449 then 5459; cancelled at 5429 then 5437. The SSE loop (serve.js:196-200) breaks when runRow status is terminal AND events.length===0. A poll iteration landing in the gap between the status commit and the terminal-event insert observes terminal status with zero new events and breaks, dropping the trailing RunFinished/RunFailed/RunCancelled event from that SSE connection. Real latent race; rare (500ms poll vs a sub-poll gap) and low severity, but genuine.

### 258. [LOW · error-handling] `packages/smithers/src/bin/smithers.js:35`  _(corroborated ×2)_

**Spawned local-CLI child has no 'error' listener: spawn failure crashes instead of falling back**

`const proc = spawn(process.execPath, [localTarget, ...process.argv.slice(2)], { stdio: "inherit", cwd }); proc.on("exit", ...)` attaches only an `exit` listener. A Node `ChildProcess` emits an `error` event (and may never emit `exit`) when the process fails to spawn (EACCES, ENOMEM, EAGAIN/fork limits, execPath transiently unreadable, etc.). With no `error` listener, EventEmitter rethrows it as an uncaught exception, so the global `smithers` process dies with a confusing stack trace. Because `delegateToLocalCliIfPresent()` has already returned `true`, the graceful fallback `await import("@smithers-orchestrator/cli")` never runs. So instead of the global CLI handling the command, a transient/broken local delegation produces a hard crash.

**Fix:** Add `proc.on("error", (err) => { console.error(err); process.exit(1); })` (or fall through to importing the bundled CLI) so spawn failures are handled instead of thrown.

*Verifier:* Confirmed at lines 35-43: `const proc = spawn(process.execPath, [localTarget, ...], {stdio:"inherit", cwd}); proc.on("exit", ...)` attaches ONLY an 'exit' listener. Node's ChildProcess emits an 'error' event on spawn failure (EAGAIN/ENOMEM/fork-limit, EACCES, etc.); with no 'error' listener EventEmitter rethrows it as an uncaught exception. And delegateToLocalCliIfPresent() returns true synchronously at line 43, so the graceful fallback `await import("@smithers-orchestrator/cli")` at line 47 never executes. The missing listener is real. Impact is low in practice: process.execPath is the currently-running bun binary (almost certainly spawnable) and localTarget was realpathSync-validated to exist at line 32, so ENOENT/EACCES are very unlikely; only transient resource-exhaustion (EAGAIN/ENOMEM) realistically triggers it. Real gap, but low probability — downgraded from medium to low.

### 259. [LOW · concurrency] `packages/smithers/src/create.js:556`

**findFreePgPort has a TOCTOU race that can cause intermittent EADDRINUSE**

findFreePgPort listens on port 0, reads the assigned port, then closes the server (`srv.listen(0,...)` then `srv.close(() => resolveFn(port))`). The caller then does `new PGLiteSocketServer({ host: "127.0.0.1", port }); await server.start();`. Between the close and the re-bind, another process (or another concurrent createSmithersPostgres call in the same process — the comment notes 'concurrent worktrees each spawn agent processes') can grab the just-freed port, making `server.start()` throw EADDRINUSE. Because the failure happens after the pglite instance is created, this surfaces as a flaky boot failure and (via the catch at line 535) tears everything down and rejects. It is a genuine race, though it bites rarely.

**Fix:** Retry server.start() on EADDRINUSE with a fresh port, or bind PGLiteSocketServer directly to port 0 and read back the actual bound port instead of pre-allocating and closing a throwaway server.

*Verifier:* findFreePgPort (lines 563-575) binds port 0, reads address().port, then srv.close(() => resolveFn(port)) — it returns the port AFTER releasing it. The caller (lines 486-487) then constructs `new PGLiteSocketServer({ host:'127.0.0.1', port })` and `await server.start()`, re-binding the same port. Between close and re-bind there is a genuine TOCTOU window where another process or another concurrent createSmithersPostgres call can grab the freed ephemeral port, making server.start() throw EADDRINUSE. The failure occurs after pglite is created and is caught at lines 542-549, which drains teardown and rethrows, surfacing as a flaky boot. This is the textbook get-free-port race; it is real but rare, so low severity.

### 260. [LOW · resource-leak] `packages/smithers/src/external/create-external-smithers.js:82`

**Default temp DB directory is never removed on cleanup**

When no `dbPath` is supplied, the DB lives in a fresh `mkdtempSync(join(tmpdir(), "smithers-ext-"))` directory. `closeDb()` only calls `sqlite.close()` and detaches the exit listener; it never removes the temp directory, so the SQLite file plus its `-wal`/`-shm` sidecars accumulate under the OS temp dir for every create/cleanup cycle (e.g. tests, gateway hot-reload). This is a slow disk leak rather than a correctness bug, but the directory the function created is left orphaned for the process lifetime and beyond.

**Fix:** Track the created temp directory and `rmSync(dir, { recursive: true, force: true })` inside `closeDb` when the path was auto-created (guard with a flag so an explicitly-passed `dbPath` is never deleted).

*Verifier:* With no dbPath, DB is created in mkdtempSync(join(tmpdir(),'smithers-ext-')) (line 82); the dir path is not retained. closeDb (lines 96-105) only calls sqlite.close() and removes the exit listener, never rmSync the temp directory, so smithers.db + -wal/-shm sidecars orphan per create/cleanup cycle. The test file rmSyncs its own tracked dirs, not the production cleanup. Confirmed slow disk leak, low severity.

### 261. [LOW · correctness] `packages/smithers/src/migrateSmithersStore.js:640`

**Reverse migration from postgres copies ALL tables in current_schema, not just Smithers tables**

For `--from postgres`, `pgTables` (lines 640-645) enumerates every BASE TABLE in `current_schema()` and the reverse copy loop (lines 1066-1069) copies all of them into the new SQLite store, also DROP-recreating same-named empty tables. The forward path is scoped to the single sqlite file via `sqlite_master`, so this is asymmetric. If the Postgres connection string (which falls through to `env.DATABASE_URL`, line 1010) points at a shared application database rather than a dedicated Smithers store, the migration will pull unrelated application tables into the SQLite output (and could fail on types it cannot map). The migration assumes a dedicated Smithers DB but does not enforce it.

**Fix:** Restrict the reverse table enumeration to recognizable Smithers tables (the `_smithers_*` set plus tables referenced by the run store / known output tables), or require an explicit Smithers schema/namespace, instead of copying every table in current_schema.

*Verifier:* Confirmed partially. pgTables (640-645) selects every BASE TABLE in current_schema() with no Smithers-table filter, and the reverse loop (1066,1068-1069) calls prepareSqliteTarget + copyPgTableToSqlite over all of them, creating same-named tables in the new sqlite store. The forward path is scoped to one sqlite file via sqlite_master, so the asymmetry is real. If --from postgres points at a shared application DB (url falls through to env.DATABASE_URL, 1010), unrelated app tables are pulled into the sqlite output. The claim's 'could fail on types it cannot map' sub-point is wrong — sqliteTypeForPg (694-700) defaults unknown types to TEXT, so it won't crash on types — but the core behavior (copies unrelated tables) is accurate. Defect only manifests when migrating from a non-dedicated postgres DB, hence low.

### 262. [LOW · error-handling] `packages/smithers/src/migrateSmithersStore.js:968`  _(corroborated ×2)_

**inferSourceBackend can raise a misleading BACKEND_CONFLICT when the requested target store is itself populated**

When no `--from` and no migration receipt exist, `inferSourceBackend` counts run history across all three backends including the requested `target`:

```js
const counts = [
  { backend: "sqlite", runCount: sqliteRunCountAt(...) },
  { backend: "pglite", runCount: await pgliteRunCountAt(...) },
  { backend: "postgres", runCount: await postgresRunCountAt(opts) },
].filter((entry) => entry.runCount > 0);
if (counts.length > 1) throw new SmithersError("SMITHERS_BACKEND_CONFLICT", ...);
```

If a prior `migrate --to postgres` partially populated the postgres target but failed before writing the receipt, retrying `migrate --to postgres` (sqlite source still populated) sees two populated backends and throws SMITHERS_BACKEND_CONFLICT telling the operator to pass `--from`, instead of the accurate "target already contains data" guidance. The candidate set should exclude `target` so a populated destination does not masquerade as an ambiguous source.

**Fix:** Filter the counted backends to exclude `target` (the migration destination) before applying the single/multiple-source heuristic, so only candidate SOURCE stores are considered for the conflict check.

*Verifier:* Confirmed. inferSourceBackend (968-972) builds the candidate counts array for sqlite, pglite AND postgres without excluding the requested target. After a forward 'migrate --to postgres' that partially populated postgres but failed before the receipt was written (marker only written on success, 1254), retrying 'migrate --to postgres' has no receipt → heuristic runs, sees sqlite>0 and postgres>0 → throws SMITHERS_BACKEND_CONFLICT ('pass --from explicitly', 974-977) rather than accurate 'target already contains data' guidance. Excluding target from the candidate set would prevent a populated destination masquerading as an ambiguous source. Real but low; substantially overlaps finding 0's root cause.

### 263. [LOW · logic] `packages/time-travel/src/jumpToFrame.js:623`

**jumpToFrame to the latest frame returns ok but never resets the run to resumable**

When `targetFrameNo === latestFrame.frameNo` the function short-circuits (lines 623-635) returning `{ok:true,...}` without performing the `updateRun({status:"running", finishedAtMs:null, ...})` that the normal path applies (lines 804-813). So rewinding a `failed`/`completed` run to its most recent checkpoint reports success yet leaves the run terminal and non-resumable, while rewinding to any earlier frame makes it running/resumable. A user rewinding to the latest checkpoint to retry observes a successful no-op that silently does nothing.

**Fix:** In the equal-frame branch, still reset the run to a resumable state (clear finishedAtMs/owner and set status to running) before returning, or return a distinct 'no-op' result so callers know the run was not made resumable.

*Verifier:* Confirmed in the code: when targetFrameNo === latestFrame.frameNo the function short-circuits at 623-635, sets auditResult='success', builds a successResult with ok:true and returns, never executing the updateRun({status:'running', finishedAtMs:null, errorJson:null, ...}) that the normal earlier-frame path applies at 804-813. So rewinding a failed/completed run to its most recent checkpoint reports success while leaving the run terminal and non-resumable, inconsistent with rewinding to any earlier frame. The docstring promises to 'make it resumable from that point.' Severity is low and there is genuine ambiguity about whether a no-op jump-to-current is intended, but the behavioral inconsistency and the silent-success footgun are real.

### 264. [LOW · logic] `packages/time-travel/src/jumpToFrame.js:1004`

**Rejected Busy/RateLimited attempts write 'failed' audit rows that count toward the rate-limit quota**

When a rewind is rejected with code `Busy` (line 552, after `canWriteAudit=true` at line 544) or `RateLimited` (line 570), no in_progress audit row was written (auditRowId stays null) but `canWriteAudit` is true, so the finally block writes a terminal audit row with `result: auditResult` which is still the default `"failed"` (lines 1004-1015). `countRecentRewindAuditRows` counts every row with `result <> 'in_progress'` (including 'failed') within a sliding window, and `evaluateRewindRateLimit` uses that count. Consequently each rejected/retried attempt adds another 'failed' row whose `timestamp_ms = startedAtMs` (now). A caller who keeps retrying while RateLimited keeps inserting fresh rows inside the sliding window, so the count never drops below `max` and the caller is effectively locked out for as long as they retry, rather than recovering after the window. Concurrent runs that all lose the lock (Busy) likewise burn the quota of the one caller that succeeds. The metric tag is reported as 'busy'/'rate_limited' (lines 1052-1055) yet the persisted audit row says 'failed', so audit and metrics also disagree.

**Fix:** Write the rejected-attempt audit row with the actual terminal result derived from the error code (e.g. 'busy'/'rate_limited' or a distinct value), and/or have `countRecentRewindAuditRows` only count attempts that actually performed a mutation (e.g. result IN ('success','partial','failed') excluding pre-flight rejections) so that being throttled does not feed back into the throttle.

*Verifier:* Confirmed end to end. For Busy, canWriteAudit is set true at line 544 BEFORE acquireRewindLock throws at 552; for RateLimited, the throw at 570 also happens after 544 and before the in_progress write at 580, so auditRowId stays null. In finally (1004-1015) with auditRowId null and canWriteAudit true, a terminal row is written with result=auditResult, which is still the default 'failed' (line 485, never reassigned on these paths) and timestamp_ms=startedAtMs (now). countRecentRewindAuditRows.js counts every row with result <> 'in_progress' within the window, and evaluateRewindRateLimit.js uses that count, so each rejected/retried attempt inserts a fresh in-window 'failed' row that itself counts toward the quota, producing a self-perpetuating lockout for a retrying caller. caller defaults to 'unknown' (normalizeCaller) so multiple processes share the bucket, confirming the cross-caller burn. The metric tag (1052-1055) reports 'busy'/'rate_limited' while the persisted audit row says 'failed', so audit and metrics disagree. Impact is low (rejections, not data loss) but real.

### 265. [LOW · correctness] `packages/time-travel/src/vcs-version/tagSnapshotVcsEffect.js:24`

**jj operation-id capture omits --ignore-working-copy, so jjOperationId describes a different snapshot than vcsPointer (and mutates the op log)**

In tagSnapshotVcs the pointer is captured first via getJjPointer(opts.cwd) (`jj log -r @ --template change_id`), which takes a working-copy snapshot (operation A). Then `runJj(["operation", "log", "--no-graph", "--limit", "1", "-T", "self.id()"], { cwd: opts.cwd })` is run WITHOUT `--ignore-working-copy`. jj snapshots the working copy on nearly every command unless that flag is passed, so this call creates a SECOND operation (operation B) and the `jjOperationId` recorded (`opRes.stdout.trim()`) is operation B, not the operation that produced vcsPointer. The sibling helper captureWorkspaceSnapshot in packages/vcs/src/jj.js deliberately does the opposite: it uses `["--ignore-working-copy", "operation", "log", ...]` precisely "so both ids describe the same snapshot". The inline comment here even says the id is captured "for precise restore". Concrete effects: (1) each VCS tag mutates the jj operation log by adding a spurious snapshot op during what should be a read-only tagging step; (2) the stored jjOperationId is inconsistent with vcsPointer, so any future precise-restore use of that column would target the wrong operation. Today jjOperationId from _smithers_vcs_tags is not consumed downstream (apps/cli reads jjOperationId from _smithers_workspace_states, not vcs_tags), so impact is currently latent.

**Fix:** Pass --ignore-working-copy to the operation log call so it neither snapshots nor diverges from the pointer: `runJj(["--ignore-working-copy", "operation", "log", "--no-graph", "--limit", "1", "-T", "self.id()"], { cwd: opts.cwd })`, matching captureWorkspaceSnapshot.

*Verifier:* Confirmed in code: tagSnapshotVcsEffect.js:24 calls runJj(["operation","log","--no-graph","--limit","1","-T","self.id()"]) WITHOUT --ignore-working-copy. The sibling captureWorkspaceSnapshot at packages/vcs/src/jj.js:159 issues the identical command WITH --ignore-working-copy, and its docstring (jj.js:145-148) explicitly documents that this is required so the op id describes the same snapshot taken by step 1 (getJjPointer) rather than a fresh one. So this file genuinely diverges from the deliberately-correct, documented pattern: the op-log read can take a second working-copy snapshot (mutating the op log) and the recorded jjOperationId is not pinned to vcsPointer's snapshot. However impact is low/latent: jj only creates a new snapshot operation if files actually change in the sub-millisecond window between the two calls (common case returns op A, consistent); vcsPointer is a stable change_id so the 'inconsistency' is largely inert; and grep confirms jjOperationId from _smithers_vcs_tags is never consumed by any restore path (rerunAtRevisionEffect.js:19 and resolveWorkflowAtRevisionEffect.js:25 use tag.vcsPointer only). Real but minor correctness/consistency defect, not a crash or data loss.

### 266. [LOW · error-handling] `packages/usage/src/anthropicHeaderUsage.js:47`

**anthropicHeaderUsage returns source:"headers" with empty windows on non-401/429 failures, rendering a blank unexplained row**

Unlike `openaiHeaderUsage`, which guards `if (!res.ok && windows.length === 0) return { source: "none", error: ... }`, `anthropicHeaderUsage` only special-cases 401 and 429:
```js
if (res.status === 401) { return { source: "none", ... }; }
const get = (name) => res.headers.get(name);
const windows = parseAnthropicRateLimitHeaders(get);
if (res.status === 429) { ... }
return { source: "headers", windows };
```
For any other non-ok status (e.g. 400 bad request, 403 forbidden, 5xx) where the count_tokens response carries no `anthropic-ratelimit-*` headers, this returns `{ source: "headers", windows: [] }` with no `error`. In `formatUsageReports`, an empty-windows report whose `source !== "none"` and whose `error` is undefined produces `note = r.error ?? (r.source === "none" ? "not supported" : "")` === "", so the user gets a completely blank row with no indication anything went wrong, instead of a readable failure reason.

**Fix:** Mirror the openai adapter: after parsing headers, if `!res.ok && windows.length === 0` return `{ source: "none", error: \`Anthropic returned ${res.status} with no rate-limit headers\` }`.

*Verifier:* Confirmed. anthropicHeaderUsage.js only special-cases status 401 (line 34-36) and 429 (line 39-46), then falls through to `return { source: "headers", windows }` at line 47 with no error. openaiHeaderUsage.js has an extra guard `if (!res.ok && windows.length === 0) return { source: "none", error: ... }` (line 53-55) that the anthropic version lacks. parseAnthropicRateLimitHeaders returns [] when no anthropic-ratelimit-* headers are present, so a 400/403/5xx response with no rate-limit headers yields { source: "headers", windows: [] } with error undefined. buildUsageReport.js passes these through verbatim (source: probe.source line 34, windows: probe.windows ?? [] line 35, error: probe.error line 41). In formatUsageReports.js line 45-47, an empty-windows report computes note = r.error ?? (r.source === "none" ? "not supported" : "") => undefined ?? ("headers"==="none"?...:"") => "", producing a row with a blank USED cell and no failure reason. Real defect but cosmetic/UX only and limited to the uncommon non-401/429 error path, so low severity is appropriate.

### 267. [LOW · correctness] `packages/vcs/src/jj.js:274`

**workspaceList human-output fallback keeps the trailing colon in workspace names**

In the `workspaceList` fallback path (used when jj is too old to support `-T`), names are parsed from the human-readable `jj workspace list` output with `const name = rawName.split(/\s+/)[0] ?? ""`. The real jj human format is `name: <change_id> ...` (the same format `workspaceAdd` itself relies on at line 210 with `listRes.stdout.includes(\`${name}:\`)`). Splitting on whitespace therefore yields the first token WITH its trailing colon, e.g. `"default:"` instead of `"default"`. The template path (line 261) returns the clean name `"default"`, so the two code paths produce inconsistent names, and any consumer comparing/forgetting by name (e.g. passing the result back into `workspaceClose`/`jj workspace forget`) would use a colon-suffixed name that does not exist. The unit test at jj-workspace.test.js:318 masks this because its fake jj prints `"* default"` (no colon), which does not match real jj output.

**Fix:** Strip a trailing colon from the parsed token, e.g. `const name = (rawName.split(/\s+/)[0] ?? "").replace(/:$/, "");`, and update the fallback test fixture to use the realistic `name: <id> ...` format so the regression is actually covered.

*Verifier:* Line 274 `rawName.split(/\s+/)[0]` parses the human `jj workspace list` output. Real jj prints `name: <change_id> ...`, confirmed by the author's own line 210 `listRes.stdout.includes(`${name}:`)` which assumes the colon is part of the format. The split therefore keeps the trailing colon (e.g. `default:`), while the template path (line 261) returns the clean `default`. The two paths are inconsistent, and a colon-suffixed name passed to workspaceClose/`jj workspace forget` would not match. The unit test masks this by emitting `* default`/`other` with no colon. Impact is low: fallback only runs on jj versions too old to support `-T`.

### 268. [LOW · correctness] `scripts/coverage.mjs:136`

**shellWords treats backslash as an escape inside single quotes**

In `shellWords`, the escape handling runs before the quote handling:
```js
if (escaped) { current += ch; escaped = false; continue; }
if (ch === "\\") { escaped = true; continue; }
if (quote) { if (ch === quote) quote = null; else current += ch; continue; }
```
This means a backslash inside a single-quoted segment is consumed as an escape character, but POSIX shells preserve backslashes literally inside single quotes (`'a\b'` → `a\b`). Here `'a\b'` parses to `ab`, dropping the backslash. A test script in package.json whose args contain single-quoted backslashes (e.g. a Windows-style path or a regex passed to bun test) would be mis-tokenized, passing wrong arguments to `bun test` and producing wrong/failed coverage runs. No current test script triggers this (all are plain `bun test [flags] tests`), so impact today is nil.

**Fix:** Only honor the backslash escape when not inside single quotes (treat `\` literally while `quote === "'"`, matching POSIX semantics).

*Verifier:* Confirmed in lines 130-148: the `escaped` handling (131-134) and `ch === "\\"` handling (136-139) run before the `quote` handling (140-144). Inside a single-quoted segment a backslash sets escaped=true and is dropped, then the following char is appended literally, so `'a\b'` tokenizes to `ab` instead of POSIX `a\b`. This is a genuine POSIX deviation in the tokenizer. But shellWords is used only by bunTestArgs to split package.json `test` scripts (lines 187-196); all such scripts are plain `bun test [flags] tests` with no single-quoted backslashes, so the defect is latent with nil current impact. Real bug, lowest severity.

### 269. [LOW · correctness] `scripts/e2e-real/capture-gifs.ts:218`

**capture-gifs.ts drives the deleted apps/smithers Playwright project**

The script is hardwired to the removed POC app: `appRoot = resolve(repoRoot, "apps/smithers")`, `reportPath = .../apps/smithers/capture-report/report.json`, and it shells out with `run("pnpm", ["-C", "apps/smithers", "exec", "playwright", "test", "--config", "playwright.capture.config.ts"])`. Since `apps/smithers` no longer exists, `pnpm -C apps/smithers` fails (non-zero status), so line 228 throws `Playwright capture run failed`. The whole GIF-capture pipeline (which build-slideshow.ts depends on for its manifest) can never succeed.

**Fix:** Remove this orphaned script or repoint appRoot/the playwright invocation at the current UI repo/app that owns playwright.capture.config.ts.

*Verifier:* Confirmed: `appRoot = resolve(repoRoot, "apps/smithers")` (line 63) and `run("pnpm", ["-C", "apps/smithers", "exec", "playwright", ...])` (lines 218-226) target a directory that no longer exists. `ls apps/` shows only cli, observability, review — apps/smithers was deleted (per project memory project_poc_ui_apps_deleted.md). I verified `pnpm -C apps/smithers exec true` returns exit code 1, so `playwright.status !== 0` at line 228 throws `Playwright capture run failed`. The script genuinely cannot succeed. Severity downgraded to low: this is orphaned dead tooling — grep shows no package.json script or CI/.github reference invokes capture-gifs.ts; its only referrer is the likewise-orphaned real-stack-e2e.tsx workflow (also pinned to the deleted apps/smithers). It crashes nothing in the live build because nothing calls it.

### 270. [LOW · crash] `scripts/e2e-real/worker.ts:8`

**worker.ts imports deleted apps/smithers module — crashes at load**

`import worker from "../../apps/smithers/src/worker"` (and `import type { CloudflareEnv } from "../../apps/smithers/src/env"`) reference `apps/smithers/src/*`, but `apps/smithers` was removed in commit 3998954004 (only `apps/cli`, `apps/observability`, `apps/review` remain — confirmed via `ls apps/`). Module resolution for `../../apps/smithers/src/worker` fails immediately, so this script throws before `Bun.serve` is ever reached. The real-stack chat e2e Worker can never boot. (Note: the `worker.fetch(request, env)` call itself is correct — the pre-deletion signature was `fetch(request, env)` with no ctx.)

**Fix:** Delete this orphaned script, or repoint the imports at wherever the Worker now lives (the UI was moved to a separate repo). Do not leave a hard import to a deleted path.

*Verifier:* Confirmed: `ls apps/` shows only cli, observability, review — apps/smithers was removed in commit 3998954004 ("remove the POC UI apps"). scripts/e2e-real/worker.ts lines 8-9 still `import worker from "../../apps/smithers/src/worker"` and `import type { CloudflareEnv } from "../../apps/smithers/src/env"`, which resolve to the deleted repo-root/apps/smithers tree (verified `apps/smithers` does not exist). If executed, module resolution fails at load, before Bun.serve (line 61) is reached, so the real-stack chat e2e Worker can never boot. The defect is genuine. Severity lowered to low because grep found no references to scripts/e2e-real/worker (no package.json script, no caller invokes it), so it is effectively orphaned dead code with no live e2e path depending on it.

