# Gateway: Origin allow-list (`allowedOrigins`) for token/jwt auth modes

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#446](https://github.com/smithersai/smithers/issues/446) · found in the test-coverage blind-spot audit (`audit/TEST-COVERAGE-AUDIT.md`, Theme B)
> Priority: defense-in-depth hardening · scope: opt-in, backward-compatible

## Problem

The Gateway's Origin allow-list config, `allowedOrigins`, exists **only** on the
`trusted-proxy` auth variant. The `token` and `jwt` auth modes — what a
browser-facing `smithers ui` / operator-UI deployment actually uses — have **no
Origin field and no Origin gate**. An operator running a localhost/LAN gateway in
token or jwt mode cannot restrict which web origins may connect, even as
defense-in-depth, so a drive-by web page can probe the gateway and open a
WebSocket / issue RPCs.

## Evidence (real source)

- `packages/server/src/GatewayAuthConfig.ts:23` — `allowedOrigins?: string[]` is
  declared **only** on the `trusted-proxy` variant; the `token` (lines 4–7) and
  `jwt` (lines 8–19) variants have no such field.
- `packages/server/src/gateway.js` — `authenticateRequest()` only checks `Origin`
  inside the `trusted-proxy` branch (~lines 3302–3311). Both chokepoints (HTTP RPC
  via `handleHttpRpc`/`handleElectricWrite`, and the WS upgrade path `listen()` →
  `handleSocket` → `handleConnect` → `authenticate`) funnel through
  `authenticateRequest`, so neither gates Origin in token/jwt mode.
- The `trusted-proxy` Origin enforcement itself works and is covered by a passing
  test (`packages/server/tests/gateway.test.jsx`, "trusted-proxy mode enforces
  allowed origins"). This ticket is the **missing** equivalent for token/jwt.

## Suggested solution (safe, opt-in, backward-compatible)

1. Add optional `allowedOrigins?: string[]` to the `token` and `jwt` variants of
   `GatewayAuthConfig` (`packages/server/src/GatewayAuthConfig.ts`).
2. Enforce it **uniformly at the top of `authenticateRequest()`** (before the mode
   switch): when the configured mode has a non-empty `allowedOrigins`, reject any
   request/WS upgrade whose `Origin` header is present and not in the list; allow
   requests with **no** `Origin` (server-to-server / CLI); when unset/empty,
   behavior is unchanged (allow all). Dedupe with the existing `trusted-proxy`
   check so there is one Origin gate, not two.

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**: boot the real Gateway and assert against real
  HTTP + WS upgrade behavior (mirror the existing trusted-proxy test). No
  `mockGateway`, no `page.route`/`routeWebSocket` fabrication, no hand-rolled
  stand-ins.
- Follow the existing test style in `packages/server/tests/gateway.test.jsx`;
  put the new test beside the trusted-proxy one.
- Keep `pnpm typecheck` green and `pnpm -C packages/server test` green.
- Scope to THIS finding only — one focused change, one atomic commit.

## Acceptance

- [ ] `token` and `jwt` variants of `GatewayAuthConfig` accept optional `allowedOrigins?: string[]`.
- [ ] `authenticateRequest()` enforces the allow-list uniformly for token/jwt (HTTP RPC + WS upgrade), deduped with the trusted-proxy path.
- [ ] Unset/empty `allowedOrigins` → unchanged (allow all). Missing `Origin` header → allowed (CLI/server-to-server).
- [ ] A real-gateway test pins: configured allow-list accepts matching Origin and rejects non-matching Origin over **both** HTTP and WS; unset allows any; missing Origin allowed.
- [ ] `pnpm typecheck` and `pnpm -C packages/server test` pass.
