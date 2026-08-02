# @smthrs/agents — src

Agent adapters for Smithers. Two families:

- **SDK agents** built on the `ai` package's `ToolLoopAgent`: `AnthropicAgent`,
  `OpenAIAgent`, `HermesAgent` (see also `resolveSdkModel.js`,
  `streamResultToGenerateResult.js`).
- **CLI agents** extending `BaseCliAgent`: `ClaudeCodeAgent`, `CodexAgent`,
  `KimiAgent`, `PiAgent`, `OpenCodeAgent`, `AmpAgent`, `AntigravityAgent`,
  `ForgeAgent`, `HermesCliAgent`, `OpenClawAgent`, `VibeAgent`, `CursorAgent`.
  `GeminiAgent` is sunset and only surfaces `GEMINI_SUNSET_MESSAGE`.

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
- package.json exports `./*` → `src/*.js`, so **every file here is public**:
  treat all filenames and named exports as API surface (tests also deep-import,
  e.g. `BaseCliAgent/BaseCliAgent.js`).
