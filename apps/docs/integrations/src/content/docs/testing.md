---
title: "Testing"
description: "Run the @smthrs/integrations suites: the fixture server tests, the three live-API suites, and the coverage flag the live runs need."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/integrations/docs/testing.md"
---

The package's suites run with vitest. Nothing in them mocks a transport: the
client and webhook suites drive a real `node:http` fixture server over a real
socket, and three suites talk to the live provider APIs.

## Run the suite

```bash
pnpm --filter @smthrs/integrations test
```

Coverage is on by default, measured over `src/**` with global thresholds
ratcheted to what the suite reaches. The thresholds carry no slack, so any
new uncovered branch fails the gate.

## Run against the live APIs

Three suites prove the wire contracts the fixtures assume are still the ones
the providers serve. Each skips, naming the credential, when it is absent:

```bash
GITHUB_TOKEN=TOKEN pnpm --filter @smthrs/integrations exec vitest run test/GitHubLive.test.ts --coverage.enabled=false
LINEAR_API_KEY=KEY pnpm --filter @smthrs/integrations exec vitest run test/LinearLive.test.ts --coverage.enabled=false
TELEGRAM_BOT_TOKEN=TOKEN pnpm --filter @smthrs/integrations exec vitest run test/TelegramLive.test.ts --coverage.enabled=false
```

Replace `TOKEN` and `KEY` with real credentials. A read-only GitHub token is
enough; all three suites are read-only, and the Telegram poll passes no
offset, so it confirms nothing and a running bot keeps its backlog.

`--coverage.enabled=false` is required for these single-file runs. The
configuration turns v8 coverage on with global thresholds, and one file
covers a few percent of `src`, so without the flag each command exits 1 after
its tests pass. Measure coverage over the whole suite instead:

```bash
GITHUB_TOKEN=TOKEN pnpm --filter @smthrs/integrations test -- --run
```

The live suites only ever raise the coverage figures, because they execute
more of `src` when a credential is present and `include` fixes the
denominator either way.

## Write a test against a client

The fixture suites show the pattern to copy: start a `node:http` server,
point the client at its origin through the `apiBaseUrl` config field, and
assert on the requests the client made. No mocking library is involved.

```ts
import { GitHub } from "@smthrs/integrations"

const client = GitHub.GitHubClient.make({ token: "t", apiBaseUrl: fixtureOrigin }, {})
```

Replace `fixtureOrigin` with the fixture server's origin. The explicit `env`
argument (`{}` here) replaces the ambient environment, so an ambient
`GITHUB_TOKEN` on the host cannot leak into the test.

## Other checks

```bash
pnpm --filter @smthrs/integrations check      # typecheck src and tests
pnpm --filter @smthrs/integrations lint       # eslint and dprint
pnpm --filter @smthrs/integrations circular   # import-cycle check
```
