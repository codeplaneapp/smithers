# @smithers-orchestrator/pi-plugin — src

Pi coding-agent (`@mariozechner/pi-coding-agent`) extension for Smithers.

- `extension.ts` — the plugin entry: registers flags (`--smithers-url`,
  `--smithers-key`), the `/smithers*` slash commands, the status bar, the MCP
  tool bridge (spawns the smithers CLI with `--mcp` and registers each MCP tool
  as a `smithers_*` Pi tool), and system-prompt injection per turn.
- `buildSmithersPiSystemPrompt.ts` — composes the injected Smithers prompt
  section (tool guidance, slash-command guide, optional docs bundle, active-run
  context). `SmithersPiRunContext.ts` is its active-run input type.
- `index.ts` — the barrel re-exporting the public surface.

Subdirectories: `api/` (thin REST/SSE helpers against the gateway `/v1`
endpoints), `runtime/` (gateway WS devtools client + inspector state store),
`views/` (pi-tui inspector panes composed by `RunInspector`).

Gotchas:

- Every file under `src/` is public API via the package.json exports wildcards
  (`./*`, `./api/*`, `./runtime/*`, `./views/*`); never move or rename files.
- `tests/extensionUiInterop.test.ts` greps `extension.ts` SOURCE TEXT: it must
  keep containing `.setStatus` and
  `normalizeState(node.state) === "waiting-approval"`, and must not contain
  `.setHeader`/`.setFooter`.
- The package intentionally has no `effect` dependency.
