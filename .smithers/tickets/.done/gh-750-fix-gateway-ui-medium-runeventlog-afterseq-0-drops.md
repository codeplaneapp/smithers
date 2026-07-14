# 🐛 fix(gateway-ui): [medium] RunEventLog afterSeq:0 drops the run's first event (seq 0)

GitHub: https://github.com/smithersai/smithers/issues/750

_via ultracode (Opus multi-agent) review_

RunEventLog hardcodes `afterSeq: 0`, which off-by-ones out the run's very first event because seq is 0-based and the hook filter is strict `>`.

**Where**
- `packages/gateway-ui/src/RunEventLog.tsx:45` — `useGatewayRunEvents(runId, { afterSeq: 0, maxEvents })`
- `packages/gateway-react/src/useGatewayRunEvents.ts:55` — `typeof afterSeq === "number" ? sorted.filter((row) => row.seq > afterSeq) : sorted` (strict `>`; `undefined` = include all)
- `packages/engine/src/engine.js:1547`, `packages/db/src/adapter.js:2603` — next seq is `COALESCE(MAX(seq), -1) + 1`, so the first event of a run has seq **0**

**Failure scenario**
Open RunEventLog on any real run. `afterSeq: 0` makes the hook keep only rows where `seq > 0`, so the seq-0 frame (typically `run.started`/`run.created`) is permanently omitted and the log visibly starts at `0001`. Passing `afterSeq` explicitly overrides the hook's `undefined` default, which would have included everything.

**Why it's masked**
`packages/gateway-ui/tests/hookComponents.test.tsx:503` seeds events starting at `seq: 1`, so the dropped seq-0 case is never exercised and tests stay green.

**Fix**
Omit `afterSeq` (let it default to `undefined`) — or pass `-1` — in RunEventLog.tsx:45. Add a fixture whose first event is seq 0 to lock the behavior.

**Why it matters**
This is the lowest-level "one line per frame" run view; on every real run it silently loses the first, often most informative, event.


> Closed by ticket-fleet: landed on main in 6cf02eec1c174e9cfa8c4fa0317eb26762e5f090.
