# tools/

Built-in agent tools (`read`, `write`, `edit`, `grep`, `bash`), exported via
`index.js` both individually and as the `tools` map. Each file pairs a plain
async `*Tool` function with a `defineTool`-wrapped ai-sdk tool.

- `defineTool.js` wraps ai-sdk `tool()`, tags it with the smithers metadata
  symbol (name/sideEffect/idempotent), merges the ambient tool context over
  `defaultToolContext()`, and requests a best-effort Tier-1 durability snapshot
  after side-effect tools.
- `utils.js` holds the shared runtime plumbing: root-dir sandboxed path
  resolution (via `@smithers-orchestrator/sandbox`), byte-capped UTF-8-safe
  output truncation, and `captureProcess` (spawn with timeout, kill-group, and
  output caps).
- `context.js` only re-exports `@smithers-orchestrator/tool-context`; it stays
  so legacy relative importers keep working.

Gotchas: bash network isolation is a real kernel sandbox only on macOS with
`sandbox-exec` — elsewhere it degrades to a bypassable denylist and warns once.
`scripts/check-docs.mjs` pins exact source fragments in `bash.js`, `utils.js`,
`write.js`, and `edit.js` to keep `docs/integrations/tools.mdx` honest, so
renaming those helpers breaks the docs gate.
