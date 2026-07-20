# BaseCliAgent/

Shared Effect-based lifecycle for every CLI agent adapter.

`BaseCliAgent.js` builds the command via the subclass's `buildCommand()`,
spawns it with `runCommandEffect` (tail-keeping stdout cap, total + idle
timeouts, abort), feeds lines to the subclass's `createOutputInterpreter()`
(NDJSON → `AgentCliEvent` stream that survives stdout truncation), classifies
quota errors (`classifyQuotaError` → `AGENT_QUOTA_EXCEEDED`) and non-retryable
config/auth errors (`AGENT_CONFIG_INVALID`), extracts token usage
(`extractUsageFromOutput` plus a completed-event fallback), records metrics,
and enriches failures with launch diagnostics. `resolveAgentAnswerText`
documents the answer-source priority: output file > streamed interpreter
answer (for stream-json) > stdout extraction > raw text.

Subclass contract: `buildCommand()` returns `{ command, args, stdin?, env?,
outputFile?, outputFormat?, cleanup?, stdoutBannerPatterns?,
stdoutErrorPatterns?, benignStderrPatterns?, errorOnBannerOnly? }`;
`createOutputInterpreter()` is optional.

`runRpcCommandEffect.js` is a separate stdin/stdout JSON-RPC transport used
only by PiAgent's rpc mode (extension UI request/response round-trips).

Everything re-exported from `index.js` is public via the package's
`./BaseCliAgent` export (`pushFlag`/`pushList` arg builders, `extractPrompt`,
`tryParseJson`, `truncateToBytes`, the `parseHelpers` guards,
`normalizeTokenUsage`, `createAgentStdoutTextEmitter`, ...). The typedef block
in `index.js` is tool-managed; the `.ts` files here are type-only sidecars.
