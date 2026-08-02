# apps/cli/src

Implementation of the `smithers` CLI (`@smthrs/cli`): a flat set
of `.js` command/helper modules with PascalCase type-only `.ts` sidecars
(e.g. `diff.js` + `RunDiffCommandInput.ts`). `index.js` (~8.5k lines) is the
bin entry (root `package.json` maps `smithers` to it) and also serves as the
MCP server; it registers every command and imports the sibling modules.
Subdirectories: `init/` (interactive init UI), `mcp/` (MCP semantic tools),
`monitor-ui/`, `agent-commands/`, `agent-wiring/`, `claude-mirror/`,
`hermes-plugin/`, `hermes-plugin-hooks/`, `openclaw-plugin/`, `util/`.

Key entry points: `index.js` (bin/MCP), `tui.js` + `watch.js` (interactive
monitor), `workflows.js`/`workflow-pack.js` (discovery + pack install),
`agent-detection.js` (agents.ts codegen for `smithers init` / `agent add`),
`gateway-runtime.js` (singleton-gateway state files/locks, spec:
`.smithers/specs/singleton-gateway.md`), `find-db.js` (store resolution).

## Publishable pack manifest

Every `.smithers/` directory initialized by `smithers init` is a publishable
pack and contains `smithers.toon`. The manifest uses TOON format and requires a
non-empty `name`; `version`, `description`, `repository`, `smithers`,
`contents`, and `capabilities` are optional and receive defaults when omitted.

```toon
name: kanban-suite
version: 0.3.0
description: Kanban workflows
repository: github.com/someuser/kanban-suite
smithers: ">=0.28"
contents:
  workflows[1]: kanban
  ui[1]: kanban
capabilities:
  bins[1]: git
  env[0]:
  writes: repo
```

`contents.workflows` and `contents.ui` enumerate pack files. Capabilities
declare requested binaries, environment variables, and writes (`repo`,
`sandbox`, or `none`). Malformed TOON and non-object `contents` or
`capabilities` values fail validation with an actionable error.

Conventions and gotchas:
- Never convert `.js` <-> `.ts`; `// @smithers-type-exports-begin/end` blocks
  are tool-managed — preserve them byte-for-byte.
- `package.json` exports `"./*"`, so every module here is externally
  importable: treat exported symbols as public surface.
- `packages/tui/src/gatewayRuntimeState.ts` MIRRORS `gateway-runtime.js`
  conventions (state dir, file names) by hand — keep them in sync.
- Some tests parse sources textually: `docs-public-surface-coverage.test.js`
  slices `event-categories.js`'s `EVENT_CATEGORY_BY_TYPE` map by its 4-space
  indentation, so that map's formatting is load-bearing.
- Depending on the grep build/locale, `index.js` can be classified as binary;
  if a repo-wide grep unexpectedly misses it, retry with `grep -a`.
