# Smithers (apps/smithers): Gateway SDK migration — slice A

This slice moves the apps/smithers PWA off its hand-written gateway RPC helper
(`src/gateway/gatewayRpc.ts`) and 3-second `setInterval` polls onto the
first-class SDK packages — `@smithers-orchestrator/gateway-client` and (where
React hooks make sense) `@smithers-orchestrator/gateway-react`.

## What changed

- **New thin wrapper**: `src/gateway/gatewayClient.ts` constructs a single
  `SmithersGatewayClient`. It injects:
  - `baseUrl` = configured gateway URL or `location.origin` — preserving the
    same-origin Worker (prod) and Vite (`/v1/rpc` proxy, dev) paths.
  - A custom `fetch` that re-runs `withAuthHeaders()` per call (Authorization
    bearer + CSRF for mutations), forwards `credentials: "include"` and the
    abort signal, and dispatches `auth-required` on a bare HTTP 401 so the
    existing `authStore` reacts exactly like the legacy `gatewayRpc` path did.
  - A `WebSocket` subclass that rewrites the upgrade pathname to `/v1/rpc` so
    the Vite proxy entry (which has `ws: true` only on `/v1/rpc`) forwards the
    upgrade — the gateway itself accepts WS on any path, so this is a no-op
    against a direct gateway.
  - Client rebuild on token rotation; CSRF rotation within a session is honored
    without rebuild via the per-fetch `withAuthHeaders()` call.
- **`gatewayStore`** now talks to the SDK:
  - `connect()` calls `client.listWorkflows()` + `client.listRuns()` in one
    `Promise.all`; the 3 s `runsPoll` `setInterval` is gone.
  - `openRun()` opens two parallel SDK streams via WebSocket — both abort when
    the user switches runs or leaves the surface, with an `AbortController`
    instead of a snapshot poll:
    1. `streamRunEventsResilient({ runId, afterSeq: 0 })` for live status
       transitions (`run.started` → "running", `run.completed` → "ok"/"failed",
       `run.paused` → "waiting"). The SDK already handles reconnect + resume
       from the last observed `seq`.
    2. `streamDevTools({ runId })` — each frame triggers a fresh
       `getDevToolsSnapshot` pull (the frames carry deltas; the existing
       `snapshotToRunNode` already understands the full snapshot shape, so we
       refetch rather than reconstructing deltas in-app).
  - **Stale-data guard**: `refreshSnapshot()` pins the expected
    `selectedRunId` at start-of-await and drops the response if the user has
    since navigated to a different run — a late snapshot can no longer clobber
    the new view.
- **`launchRun` payload fixed**: the legacy fetch path sent `{ workflowKey }`,
  but the gateway's `launchRun` request schema requires `{ workflow }`. The
  SDK is typed against the schema, so the bug is impossible going forward.
- **`gatewayRpc.ts` is removed** — the wrapper + the SDK supersede it.

## Auth surface

The wrapper preserves every behavior the old `gatewayRpc.ts` had on the auth
path:
- bearer Authorization from the existing session-storage token,
- CSRF X-CSRF-Token header for mutating methods,
- `credentials: "include"` so a same-origin session cookie is sent,
- 401 → `handleAuthRequired()` dispatch, picked up by the `authStore` and the
  router's `/login` redirect.

RPC-frame `Unauthorized` errors arrive as a `GatewayRpcError` and the store's
`isAuthError` maps them onto `status: "unauthorized"`.

## Tests

- **`src/gateway/gatewayClient.test.ts`** — wrapper unit tests under happy-dom:
  same-origin `baseUrl`, client memoization, token-rotation rebuild, the
  WebSocket subclass + `/v1/rpc` path constant, the auth-fetch path's
  Authorization injection on a real `fetch` interception, 401 firing
  `handleAuthRequired`, and `isAuthError` triangulation.
- **`src/gateway/gatewayStore.test.ts`** — store-level tests against an
  in-memory fake SDK client (no network):
  - `connect()` loads workflows + runs and goes online; an `Unauthorized` RPC
    error flips status to `unauthorized`.
  - `launch()` sends `{ workflow }` (NOT `{ workflowKey }`) and refreshes the
    runs list.
  - `openRun()` warm-loads a snapshot, then live-applies `run.completed`
    frames onto the runs list WITHOUT another `listRuns` poll.
  - `streamDevTools` frames each trigger a fresh snapshot pull.
  - A stream that ends silently (the SDK's resilient reconnect behavior on a
    silent close) leaves the store ready to re-subscribe on the next open.
  - A late snapshot for a stale run does NOT clobber the next run's view.
- **`tests/e2e/gatewaySdk.spec.ts`** — Playwright e2e against the real
  gateway fixture. Verifies that opening the inspector upgrades a WebSocket on
  `/v1/rpc` (proof the SDK transport is engaged) and that the status pill
  resolves through the real RPC + stream path.

## Out of scope

- Migrating `WorkflowRunUi` / `GatewayRunInspector` to `useGatewayRun` /
  `useGatewayRunEvents` from `@smithers-orchestrator/gateway-react` is a
  separate slice (slice B). The store/SDK boundary is enough to remove the
  polling loop and fix the `launchRun` bug today.
- Mounting `SmithersGatewayProvider` at the app root + a hooks-only inspector
  surface — folded into slice B once the React tree is reorganized.
