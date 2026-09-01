# @smthrs/gateway

## [Unreleased]

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added the assembled workspace gateway: `POST /rpc`, `/rpc/ws`,
  `POST /projections`, `/projections/ws`, `POST /sync`, `/sync/ws`, and an
  unauthenticated `GET /health`, as one application layer with
  `node/NodeGateway` as its Node host.
- Added the served read path: `workspace-runs`, `run-summary`, `run-events`,
  `transcript`, `run-tree`, `approvals`, and `node-output`, folded from the
  control events `Control.watch` publishes and served as snapshots, replacement
  deltas, and keepalive frames.
- Added `Approval.Submit`, the one composite mutation a product client cannot
  assemble safely on its own, journaled under the operator the shared bearer
  middleware authenticated rather than the composition's default.
- Added keepalives on `/rpc/ws` and `/projections/ws` at a cadence well inside
  the 600-second idle cut a relay applies, and an ingress guard that answers
  401, 400, and 413 with a typed body instead of an empty 500.
- Added `Diagnosis`, which computes what happened to a run from that run's own
  events and renders it as the `run-summary` row's verdict and diagnosis card.
- Added `NodeGateway.bindRefusal`, `GatewayError.settingRefusal`, and
  `GatewayServer.exceededBodyLimit`, so a start-time refusal is a typed
  `bind_failed` value and a body-read failure is told apart from a body that
  was too big.
- Added `GatewaySchema.rowSchemaFor`, a resume cursor on
  `Projection.Subscribe`, and same-named type aliases for every public selector
  and frame schema, so a client decodes rows and resumes a subscription instead
  of casting and re-reading.
- Added package-owned documentation: `docs/`, `Package.ts`, and a `BUILD.ts`
  `docsPages` target that writes and drift-checks `docs/pages/api/gateway.md`.

### Changed

- A subscription now reads the control plane exactly once. The rows, the cursor
  the snapshot advertises, and the sequence its deltas start after all come
  from that read, so an event landing mid-read is no longer delivered as both a
  row and a delta.
- A delta now folds the events accumulated on the stream instead of re-reading
  the whole journal per event, so following a run costs one read whatever its
  length.
- `GatewayError.cause` now carries a redacted `{_tag, code}` summary rather than
  the whole internal `ControlError`, and the full cause is logged server-side.
- An unknown run now fails `run_not_found` identically for every run-scoped
  selector, rather than failing for two of them and answering an empty snapshot
  for the other four.
- `Diagnosis.clip` now cuts on code points, never emitting a lone surrogate,
  and honours widths of 0 and 1; `firstLine` no longer leaves a carriage return
  on a CRLF cause.
- `Diagnosis.digest` now measures a run's span from the kinds it handles, so
  the keepalive merged into a followed `Watch` no longer reports a run as
  having lasted as long as it was watched.
- `nodeOutput` now keys its rows exactly as `runTree` does, even when an event
  names no run, so the two folds cannot disagree about which node produced
  which output.
- `GatewayServer.layer` now takes an options object rather than two positional
  optionals.

### Removed

- Removed `plan-cards` from `ProjectionName`, `PlanCardsSelector`, and the read
  path: the declared projection set equals the served set (rc-contract R-8), and
  a plan card is what `Control.plan` returns rather than something projected.
- Removed the never-produced `GatewayErrorCode` members `already_running`,
  `not_running`, `token_expired`, `unsupported_projection`,
  `subscription_expired`, `overflow`, and `sweep_failed`.
- Removed the never-emitted `OverflowFrame`, `ExpiredFrame`, `TerminalFrame`,
  and `UnauthorizedFrame`, and the unreferenced `SubscriptionTick` and
  `SubscriptionWatch` schemas.
- Removed `SubmitApprovalOutput.resume` and the `layerRefuseMalformedRpc`
  alias: a first release has nothing to be compatible with (rc-contract
  section 11).
- The 0.x gateway protocol is replaced rather than adapted. No 0.x method name
  or path is served and there is no compatibility projection (rc-contract
  section 7).
