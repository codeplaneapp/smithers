# End-to-end tiers (`apps/ui/e2e/`)

The hermetic web harness that lived here (`run.ts`, `suites/`, the Worker
doubles) was removed with the web build path on 2026-08-26
(`docs/LOCAL-APP.md`). End-to-end coverage has one browser tier and one
packaged-app tier.

| Tier | Script                               | Runner                 | Specs                    |
| ---- | ------------------------------------ | ---------------------- | ------------------------ |
| T1   | `pnpm --filter smithers-ui test:e2e` | `playwright.config.ts` | `playwright/*.spec.ts`   |
| T2   | `bun run test:e2e` (repository root) | `packaged/run.ts`      | `packaged/*.e2e.test.ts` |

T1 boots the local origin without a window (`playwright/webserver.ts` builds
the SPA and runs `bun src/bun/serve.ts` on port 47311 with
`SMITHERS_CHAT_STUB=1`) and drives it with headless Chromium. Specs that
belong to a lane whose server seams do not exist yet keep the server behind
`page.route` / `page.routeWebSocket` (`tabs.spec.ts`), so they pass unchanged
against the real origin.

T2 builds the stable Electrobun package and launches its real executable with
the production native renderer. A test-only, bearer-authenticated HTTP bridge
binds `127.0.0.1` only when the runner supplies `SMITHERS_E2E_BRIDGE=1`; DOM
evaluation crosses Electrobun's own WebView RPC. The runner gives every test a
temporary home and fixed random local origin, so WebKit state survives
relaunch without touching the user's profile. Failure logs and best-effort
screenshots land under `test-results/electrobun-packaged/`. macOS only.

`native/` holds the main-process subprocess probe driven by
`src/bun/Main.test.ts`; see `native/README.md`.
