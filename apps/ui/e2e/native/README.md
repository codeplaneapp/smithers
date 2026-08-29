# Native main-process coverage

The Electrobun main process (`src/bun/index.ts`) is a top-level-await module
that starts the local origin and builds the window as an import side effect,
and `electrobun/main` dlopens a native wrapper. So it is exercised in a
subprocess against a recording host fake:

- **`Probe.ts`**: the wire contract between the driver and the test. No side
  effects, so a test can import it.
- **`MainProcess.ts`**: replaces `electrobun/main` with a fake window, folder
  dialog and system browser, imports the REAL entrypoint, exercises the RPC
  handlers it registered, probes the origin it started, and prints one JSON
  report. Driven by `src/bun/Main.test.ts`, not run by hand.

The local server the entrypoint starts is the real one; only the host is
faked.

The real window is covered by tier T2 (`e2e/playwright/native/`,
`pnpm --filter smithers-ui test:e2e:native`): the dev build bundles CEF, the
launcher starts the built `.app` with `ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT`,
and Playwright attaches over CDP. See `docs/LOCAL-APP.md`, "Test tiers".

```sh
cd apps/ui
bun test src/bun                              # no window needed, runs anywhere
pnpm --filter smithers-ui test:e2e:native    # macOS, builds and launches the app
```
