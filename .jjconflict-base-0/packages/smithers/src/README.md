# smithers-orchestrator — src

Source of the published `smithers-orchestrator` facade package. `index.js`
aggregates the whole workspace API; the real logic lives in a handful of files:

- `create.js` — the core factories (`createSmithers`, `createSmithersCloudflare`,
  `createSmithersPostgres`).
- `openSmithersBackend.js` / `openSmithersStore.js` — open exactly one resolved
  backend store (adapter-level, used by CLI/server read paths).
- `resolveSmithersBackendChoice.js` — the fail-loud backend/migration gate.
  Resolution order: explicit options → `SMITHERS_BACKEND` → `smithers.config.ts`
  → `.smithers/backend.json` + `migrated.json` markers → sqlite default. Every
  boot path shares it.
- `migrateSmithersStore.js` — one-shot sqlite↔pglite/postgres store copy behind
  `smithers migrate`; writes the `migrated.json` receipt.

One-line modules (`gateway.js`, `scorers.js`, `ui.js`, …) are subpath-export
facades re-exporting sibling workspace packages. PascalCase `.ts` files are
type-only sidecars consumed via JSDoc `import(...)` and package `types` fields.

Gotchas:

- `package.json` exports `./*` → `./src/*.js`, so EVERY top-level file here is a
  published subpath — never rename, move, or delete one.
- `// @smithers-type-exports-begin/end` blocks (e.g. in `index.js`,
  `examples-entry.js`) are tool-managed; preserve them byte-for-byte.
- `bin/smithers.js` re-execs the nearest project-local smithers install
  (tsc-style) before falling back to `@smithers-orchestrator/cli`, avoiding the
  two-React-copies trap.
