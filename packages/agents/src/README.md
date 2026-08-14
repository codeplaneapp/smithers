# @smthrs/agents — src

Agent adapters for Smithers. Three families:

- **SDK agents** built on the `ai` package's `ToolLoopAgent`: `AnthropicAgent`,
  `OpenAIAgent`, `HermesAgent` (see also `resolveSdkModel.js`,
  `streamResultToGenerateResult.js`).
- **CLI agents** extending `BaseCliAgent`: `ClaudeCodeAgent`, `CodexAgent`,
  `KimiAgent`, `PiAgent`, `OpenCodeAgent`, `AmpAgent`, `AntigravityAgent`,
  `ForgeAgent`, `HermesCliAgent`, `OpenClawAgent`, `VibeAgent`, `CursorAgent`.
  `GeminiAgent` is sunset and only surfaces `GEMINI_SUNSET_MESSAGE`.
- **Headless native bridge agents** implementing `AgentLike` directly:
  `NanocodexAgent` starts one `smithers-nanocodex` process and one stock
  Nanocodex turn per call. It uses generic resume-only checkpoints instead of
  CLI session capture and deliberately rejects JavaScript tools, MCP,
  subagents, custom endpoints, and workspace relocation. Protocol v1 ships
  Linux x86_64 (glibc 2.35+) and macOS arm64 workers. The adapter spawns the
  matching `smithers-nanocodex` binary directly — Bubblewrap / `sandbox-exec`
  must not wrap it. Isolation, if required, is an outer Smithers `<Sandbox>`.
  The bridge executable is an external pinned release: it is never bundled or
  downloaded by runtime code. `binary` selects a path or a command on `PATH`.
  Public preflight is provider-free; each `generate()` starts one fresh serve
  worker. The stock model is allowlisted (`gpt-5.6-sol` default, plus
  `gpt-5.6-terra` / `gpt-5.6-luna`) and fixed for a native thread. Resume
  requires the same canonical workspace, and opaque checkpoints must be treated
  as secrets. Process-group cleanup is best-effort, not filesystem, network,
  device, or credential isolation.

Support directories: `BaseCliAgent/` (shared CLI lifecycle), `agent-contract/`,
`capability-registry/`, `cli-capabilities/`, `cli-surface/`, `diagnostics/`,
and toolset factories (`http/`, `mcp/`, `web-search/`, `image-generation/`,
`document-parsing/`, `transcription/`).

Conventions and gotchas:

- Implementation is `.js` with JSDoc types; each `XxxAgent.js` pairs with a
  type-only `XxxAgentOptions.ts` sidecar.
- `index.js` is the barrel; its typedef block between the
  `@smithers-type-exports` markers is tool-managed — do not hand-edit.
- `AgentLike.ts` is the minimal contract the engine consumes;
  `__type-tests__/` asserts every concrete agent stays assignable to it.
- package.json generally exports `./*` → `src/*.js`, so source filenames are
  normally public API (tests also deep-import, e.g. `BaseCliAgent/BaseCliAgent.js`).
  The `nanocodex/` wire/codec/process modules are explicitly private; only the
  root `NanocodexAgent` class and option/auth types are supported public API.
