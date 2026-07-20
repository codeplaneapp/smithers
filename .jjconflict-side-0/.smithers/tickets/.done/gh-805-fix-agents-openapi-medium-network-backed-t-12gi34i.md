# 🐛 fix(agents/openapi): [medium] network-backed tools discard the AI SDK abortSignal

GitHub: https://github.com/smithersai/smithers/issues/805

_via 2026-07 full-codebase audit_

## Summary

AI SDK tool execution supplies ToolExecutionOptions.abortSignal, but Smithers network-backed tools declare one-argument execute functions and never propagate the signal through fetches, provider calls, MCP requests, or polling delays.

## Where

- `packages/agents/src/http/createHttpTool.js:37`
- `packages/agents/src/document-parsing/createDocumentParsingToolset.js:68`
- `packages/agents/src/mcp/createMcpToolset.js:68`
- `packages/openapi/src/tool-factory/_helpers.js:356`
- `packages/agents/src/transcription/createTranscriptionTool.js:49`

## Failure scenario / repro

A document-parser provider used a never-settling fetch. Aborting the AI SDK signal did not reach fetch and the tool remained pending.

## Impact

Cancelled runs continue network work, provider polling, quota consumption, and resource retention.

## Suggested fix

Accept execution options, compose the supplied signal with local deadlines, thread it through every provider interface/fetch/MCP call, and make polling delays abortable.

## Tests

- For every network-backed tool family, abort a never-settling operation and assert prompt rejection plus underlying cancellation

## Dedupe notes

#671 and #738 cover different sandbox/provider boundaries.


> Closed by ticket-fleet sync: All listed families propagate ToolExecutionOptions.abortSignal and have cancellation coverage. HTTP composes caller cancellation with timeout in packages/agents/src/http/createHttpTool.js:37-65, tested by http-tool-abort.test.js. Document parsing forwards signals through the provider interface, Firecrawl, Mistral, LlamaParse fetches, and abortable polling in packages/agents/src/document-parsing/DocumentParsingProvider.ts:3-15 and createDocumentParsingToolset.js:68-69, 258-315, tested by document-parsing-cancellation.test.js, document-parsing-custom-provider-abort.test.js, document-parsing-llamaparse-abort.test.js, and document-parsing-mistral-abort.test.js. MCP forwards the signal to client.callTool in packages/agents/src/mcp/createMcpToolset.js:68,119-127, tested against a real stdio MCP server by mcp-toolset-cancellation.test.js. OpenAPI combines external and Effect fiber signals and passes them through redirect hops and fetch in packages/openapi/src/tool-factory/_helpers.js:249-264,347,379-397,478-489, tested by execution-cancellation.test.js. Transcription forwards signals to Whisper download/transcription and Deepgram fetches in packages/agents/src/transcription/createTranscriptionTool.js:49-58,192-248, tested by transcription-tool.test.js. The focused suite passed 47 tests with 0 failures across 8 files.
