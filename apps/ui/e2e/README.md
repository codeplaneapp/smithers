# End-to-end tiers (`apps/ui/e2e/`)

The hermetic web harness that lived here (`run.ts`, `suites/`, the Worker
doubles) was removed with the web build path on 2026-08-26
(`docs/LOCAL-APP.md`). End-to-end coverage is the two Playwright tiers.

| Tier | Script | Config | Specs |
| --- | --- | --- | --- |
| T1 | `pnpm --filter smithers-ui test:e2e` | `playwright.config.ts` | `playwright/*.spec.ts` |
| T2 | `pnpm --filter smithers-ui test:e2e:native` | `playwright.native.config.ts` | `playwright/native/*.native.spec.ts` |

T1 boots the local origin without a window (`playwright/webserver.ts` builds
the SPA and runs `bun src/bun/serve.ts` on port 47311 with
`SMITHERS_CHAT_STUB=1`) and drives it with headless Chromium. Specs that
belong to a lane whose server seams do not exist yet keep the server behind
`page.route` / `page.routeWebSocket` (`tabs.spec.ts`), so they pass unchanged
against the real origin.

T2 builds the Electrobun app with CEF, launches it with
`ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT`, and attaches over CDP
(`playwright/native/run.ts`). macOS only.

`native/` holds the main-process subprocess probe driven by
`src/bun/Main.test.ts`; see `native/README.md`.
