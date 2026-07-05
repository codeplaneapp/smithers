# @smithers-orchestrator/cloudflare — src

Single-module package (`index.js`) with three Cloudflare integrations:

- `createCloudflareDurableObjectSqliteDescriptor` — Durable Object
  `ctx.storage` SQLite (or its `.sql` handle) → Smithers db descriptor; binds
  the real `storage.transaction` when available.
- `createCloudflareD1SqliteDescriptor` — D1 → descriptor. Its `transaction()`
  is a NON-ATOMIC pass-through (D1 has no interactive transactions) — read the
  JSDoc warning before using it for durable run state; prefer the Durable
  Object descriptor there.
- `createCloudflareSandboxProvider` — Cloudflare Sandbox SDK → Smithers
  `SandboxProvider`. It writes `.smithers/sandbox-request.json` into the
  sandbox workdir, runs the entry command, and reads the result JSON from
  stdout or `.smithers/sandbox-result.json` (paths handed to the command via
  `SMITHERS_SANDBOX_REQUEST_PATH` / `SMITHERS_SANDBOX_RESULT_PATH`).

Gotchas:

- `@cloudflare/sandbox` is an optionalDependency, imported lazily inside
  `run()` so the package loads without it.
- `createMockCloudflareSandboxEnvironment` is an exported test double
  implementing the SDK subset used here (consumed by `../tests`).
- `src/index.d.ts` is generated-but-committed — never hand-edit it.
