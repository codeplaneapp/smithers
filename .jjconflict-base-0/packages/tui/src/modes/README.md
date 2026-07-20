# modes/

One full-screen monitor mode per file: `TreeMode` (tree + node inspector tabs +
approval/human banners), `GraphMode` (DAG layout), `LogMode` (event stream with
attempt filter), `TimelineMode` (scrubable tick strip), `HijackMode` (suspend
the TUI and hand the terminal to `smithers hijack`).

- Pattern: each `<X>Mode` is a thin wrapper that reads gateway hooks and
  forwards to an exported presentational `<X>View`/panel component; render
  tests mount the real view with injected data so tests can't drift from
  production. Pure logic lives in the sibling `*Utils.ts` files, which the
  `tests/*-mode.test.ts` suites import directly.
- `eventFrame.ts` is the shared envelope normalizer: the live gateway wraps
  engine events in a `run.event` frame, so every event reader goes through
  `unwrapEvent`/`normalizeFrame`.
- `approvalUtils.ts` encodes the exact decision shapes the gateway's
  `validateApprovalDecision` accepts — select/rank payloads must nest under
  `value` (e.g. `{ approved: true, value: { selected } }`).
- Gotchas: rows/selections/collapse state are keyed by `runNodeKey` (unique per
  loop/retry attempt), never the logical node id. `humanUtils.ts` exists
  because HumanTask nodes must NOT be approved from the monitor — only
  `smithers human` can supply the typed answer; approving strands the run.
