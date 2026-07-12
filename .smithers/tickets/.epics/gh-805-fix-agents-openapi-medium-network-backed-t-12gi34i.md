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
