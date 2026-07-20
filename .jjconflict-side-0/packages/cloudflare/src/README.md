# @smithers-orchestrator/cloudflare — src

Single-module package (`index.js`) with three Cloudflare integrations:

- `createCloudflareDurableObjectSqliteDescriptor` — Durable Object
  `ctx.storage` SQLite (or its `.sql` handle) → Smithers db descriptor; binds
  the real `storage.transaction` when available.
- `createCloudflareD1SqliteDescriptor` — D1 → read-mostly descriptor. D1 has no
  interactive transactions, so the descriptor reports that limitation and
  Smithers rejects transactional writes before they begin; prefer the Durable
  Object descriptor for durable run state.
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
