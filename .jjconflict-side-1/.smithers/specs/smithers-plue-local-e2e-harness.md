# Smithers + Plue local e2e harness

Status: shipped (worktree `worktrees/smithers-plue-local-e2e-harness-20260607`).

## Why

`apps/smithers` already talks to a Smithers gateway in e2e via
`tests/fixtures/gatewayFixture.tsx`, but the second backend it depends on — the
Plue / jjhub REST API (repos, issues, landings, workspaces, notifications,
auth-split flows) — has no local counterpart. Without one, every list, every
detail, every notification fan-out in the new PWA either lives off seeded
mocks or requires a developer to clone Plue and run its docker-compose stack.

That gap blocks three things:

1. Real-backend e2e for the platform surfaces (issues / landings / workspaces /
   notifications) that already have feature cards and canvas routes.
2. Worker proxy regression: split-mode (`AUTH_API_BASE_URL` ≠ `GO_API_BASE_URL`)
   and monolith fallback should each have a green test path that exercises
   pagination, large lists, and 401/403 propagation.
3. Future Smithers Cloud — when apps/smithers ships on Workers in front of
   Plue, the same harness needs to work in CI without docker.

## Components

| Piece | File | What it is |
|---|---|---|
| Deterministic seed | `apps/smithers/tests/fixtures/fakePlueSeed.ts` | Pure data + builders. Repos, 250 issues per repo, 60 landings per repo, workspaces, notifications. |
| Fake Plue HTTP server | `apps/smithers/tests/fixtures/fakePlueHost.ts` | Bun `Bun.serve` that mirrors the Plue routes the new UI calls. Cursor pagination via `Link: rel="next"`. 401/403 propagation. CORS that echoes loopback origins. Optional failure modes (`FAKE_PLUE_FAIL_REPOS=401`, `FAKE_PLUE_DOWN=1`). |
| Fixture contract tests | `apps/smithers/tests/fixtures/fakePlueHost.test.ts` | Pin the shapes apps/smithers consumes. Pagination, CORS, auth-split, failure injection. |
| Worker proxy integration | `apps/smithers/src/workerPlue.test.ts` | Drives `src/worker.ts` against the fake host. Split (auth ≠ platform), monolith fallback, Plue down, 401/403 propagation, large list streaming. |
| Playwright e2e | `apps/smithers/tests/e2e/plueHarness.spec.ts` | Browser -> vite proxy -> fake-plue. Pagination, detail, landings, workspaces, notifications, auth redirect, 401/403, Plue unavailable. |
| vite wiring | `apps/smithers/vite.config.ts` | `SMITHERS_PLATFORM_PROXY_TARGET` env, falling back to `SMITHERS_AUTH_PROXY_TARGET` for monolith mode. With both set, platform-user subpaths are routed before the broader auth `/api/user` prefix. |
| Playwright wiring | `apps/smithers/playwright.config.ts` | Boots fake-Plue auth/platform hosts and a dedicated Plue-harness Vite origin while keeping the main Worker-backed app origin for the rest of the e2e suite. |
| Docker compose passthrough | `apps/smithers/tools/docker-compose.plue.yml` | Opt-in. Boots an apps/smithers dev container that points its proxies at a Plue stack on `host.docker.internal`. |
| Dev script | `apps/smithers/scripts/dev-with-plue.sh` | One command to bring Plue's compose stack up, wait for the api, and start `vite` proxied at it. |

## Routes the fake host covers

```
GET  /api/user                                       — me
GET  /api/user/repos                                 — repos (paginated)
GET  /api/repos/:owner/:repo                          — one repo
GET  /api/repos/:owner/:repo/issues                   — issues (paginated, state filter)
GET  /api/repos/:owner/:repo/issues/:n                — one issue
GET  /api/repos/:owner/:repo/landing-requests         — landings (paginated)
GET  /api/repos/:owner/:repo/workspaces               — workspaces
GET  /api/notifications                              — notifications
GET  /api/auth/github/authorize                       — GitHub 302
GET  /api/auth/auth0/authorize                        — Auth0 302
GET  /api/auth/sse-ticket                            — SSE ticket (stub)
GET  /health                                         — Playwright probe
```

## Auth split vs monolith — proven distinct

Two `SMITHERS_*_PROXY_TARGET` envs let the harness model either deployment shape:

- `SMITHERS_AUTH_PROXY_TARGET` — proxies `/api/auth/*`, `/api/user` exact, and
  auth-only user subpaths such as `/api/user/keys`.
- `SMITHERS_PLATFORM_PROXY_TARGET` — proxies platform-user subpaths such as
  `/api/user/repos`, plus `/api/repos`, `/api/orgs`, `/api/search`,
  `/api/notifications`, `/api/integrations`, `/api/oauth2`, `/resolve`.

When only `SMITHERS_AUTH_PROXY_TARGET` is set, platform routes fall back to it
(monolith). When both are set, they can point at different fake hosts (split).
The Worker (`src/worker.ts`) already supports the same shape via
`AUTH_API_BASE_URL` and `GO_API_BASE_URL`; `workerPlue.test.ts` exercises both
paths.

Split mode is proven, not assumed: each fake-Plue host reads
`FAKE_PLUE_SERVICE_LABEL` from its env and tags every response with a
`service_label` field. Playwright boots two hosts (`auth`, `platform`); the
worker tests do the same. Misrouted requests would surface the wrong label and
the assertion fails closed.

## Corner cases covered

| Case | Where |
|---|---|
| Plue unavailable | `plueHarness.spec.ts` — a real platform-prefixed fetch through the vite proxy, made to 503 via the `x-fake-plue-down: 1` per-request override. Also `workerPlue.test.ts` (`FAKE_PLUE_DOWN=1` → 503, plus a per-request override variant). |
| Auth base distinct from platform base | `workerPlue.test.ts` "split mode by label" group + "authBase stays up serving identity even when platformBase is hard-down". Also `plueHarness.spec.ts` "split-mode routing" - `service_label` proves the routing claim. |
| Monolith fallback | `workerPlue.test.ts` "platform routes fall back to AUTH_API_BASE_URL when GO_API_BASE_URL is unset" + "platform routes 404 cleanly when no Plue base is configured at all". |
| Pagination cursors | All three layers (fixture, worker, browser). 250 issues → 3 pages × 100. |
| Large repo/issue lists | Same as pagination — the fake host serves 250 issues per repo, walked exhaustively. |
| 401 propagation | Fixture + worker + browser tests. |
| 403 propagation | `notifications?admin=1` with a non-admin token. Fixture + worker + browser tests. |
| GitHub authorize | `plueHarness.spec.ts` uses Playwright's APIRequestContext (`maxRedirects: 0`) to assert status 302 + tight bounds on `client_id`, `state`, `provider`, `redirect_uri` host + path + query. |
| CORS / same-origin | Fixture echoes 127.0.0.1, `[::1]`, and `localhost` origins; rejects external. Browser tests assert `/api/repos` resolves on `baseURL` (same-origin). |
| UI / store seam | `plueHarness.spec.ts` calls the app's own `platformJson` via a build-gated `window.__smithers_test` hook (`VITE_SMITHERS_E2E_TEST_HOOKS=1`) and asserts the seeded shape plus a `PlatformError` on the 503 path. |
| Deterministic seeded data | `fakePlueSeed.ts` is pure; no Math.random / Date.now. Builders return stable shapes per `(repo, count)`. |

## Future Smithers Cloud

The same harness drives a `docker compose -f apps/smithers/tools/docker-compose.plue.yml`
override. When apps/smithers ships on Workers, the production wiring is
identical: the Worker proxies auth and platform paths, the browser sees them
same-origin, and the e2e suite swaps fake Plue for real Plue by changing the
auth and platform proxy targets without touching specs.

## Running

```
# Unit + fixture + worker integration tests (deterministic, < 1s wall-clock).
pnpm -C apps/smithers run test:plue

# Full Playwright spec (boots fake-plue alongside the rest of the stack).
pnpm -C apps/smithers exec playwright test tests/e2e/plueHarness.spec.ts

# Real Plue stack instead of the fake (requires docker + a Plue checkout).
PLUE_DIR=/path/to/plue apps/smithers/scripts/dev-with-plue.sh
```

## Not done

- Wiring the seeded data into the React stores (`issuesStore`, `landingsStore`,
  `notificationsStore`). The harness is the transport; the stores still serve
  in-memory mocks. The follow-up flips the stores to call `platformJson` and
  consume the real shapes — landed separately to keep the diff focused.
- Pretending to be jjhub for SSE / WebSocket flows (notifications stream,
  workspace pty). Same reason — separate seam, separate harness.
