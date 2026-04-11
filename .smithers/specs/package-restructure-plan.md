# Package Restructure Plan

> Move `src/` into `packages/smithers/` and split CLI into its own package.

## Final Package Structure

```
packages/
  core/              (@smithers/core — Effect runtime, scheduler, graph, state)
  smithers-core-react/ (@smithers/core-react — React reconciler, components, driver)
  smithers/          (@smithers/smithers — main library, replaces root src/)
  smithers-cli/      (@smithers/cli — CLI binary + MCP)
```

## Dependency Graph

```
@smithers/core        (Effect-only, no React)
    ↑
@smithers/core-react  (React adapter, depends on core)
    ↑
@smithers/smithers    (main library, depends on core + core-react)
    ↑
@smithers/cli         (CLI binary, depends on smithers)
```

---

## packages/smithers/ — The Main Library

Everything currently in `src/` EXCEPT `cli/` and `mcp/`:

- Top-level type files (SmithersWorkflow, SmithersCtx, XmlNode, etc.)
- `agents/` — agent implementations
- `components/` — JSX components (will eventually re-export from @smithers/core-react)
- `db/` — database adapter
- `dom/` — reconciler/renderer
- `effect/` — Effect runtime bridges
- `engine/` — core execution engine
- `external/` — Python/external runtime
- `gateway/` — WebSocket gateway
- `hot/` — hot reload
- `ide/` — IDE service
- `memory/` — memory store
- `observability/` — observability facade
- `openapi/` — OpenAPI tools
- `pi-plugin/` — Pi agent plugin
- `rag/` — RAG pipeline
- `sandbox/` — sandbox execution
- `scorers/` — evaluation scorers
- `server/` — HTTP server
- `time-travel/` — time travel/snapshots
- `tools/` — built-in tools
- `utils/` — shared utilities
- `vcs/` — jj VCS integration
- `voice/` — voice providers
- `devtools/` — React DevTools bridge

Subpath exports preserved: `./gateway`, `./voice`, `./rag`, `./memory`, etc.

---

## packages/smithers-cli/ — The CLI Package

- `cli/` — all CLI commands, formatters, TUI, scheduler, supervisor, hijack, ask (~15K lines)
- `mcp/` — MCP semantic server and tools (heavily depends on CLI utilities)

Binary entry: `smithers` command

Dependencies: `@smithers/smithers`, `incur`, `@opentui/core`, `@opentui/react`, `picocolors`, `@modelcontextprotocol/sdk`

---

## Refactoring Required

1. **`pi-plugin/extension.ts`** imports `cli/agent-contract`. Move `agent-contract.ts` to `agents/` or `utils/` so `packages/smithers/` doesn't depend on CLI.

2. **Test files** that test CLI functionality move to `packages/smithers-cli/tests/`. Core tests stay in `packages/smithers/tests/`.

3. **Root `package.json`** becomes a workspace root only. Each package gets its own `package.json`.

---

## What NOT to Split

- **Server/gateway** — part of public API, only 5.2K lines, users import directly
- **Agents** — consumed by engine and components, tight bidirectional coupling
- **Voice, RAG, memory, scorers, openapi** — each under 1.5K lines, subpath exports already provide clean boundaries
- **No more than 4 packages total** — each adds CI/version/publish overhead
