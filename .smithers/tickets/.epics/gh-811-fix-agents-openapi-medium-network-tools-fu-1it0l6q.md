# 🐛 fix(agents/openapi): [medium] network tools fully buffer unbounded remote response bodies

GitHub: https://github.com/smithersai/smithers/issues/811

_via 2026-07 full-codebase audit_

## Summary

Agent-callable network tools consume complete remote bodies with text(), json(), or blob() and impose no default response-size limit.

## Where

- `packages/agents/src/http/createHttpTool.js:191-203`
- `packages/agents/src/transcription/createTranscriptionTool.js:199-202`
- `packages/openapi/src/tool-factory/_helpers.js:230-235`

## Failure scenario / repro

A model-selected endpoint returns an extremely large or endless chunked body. Smithers keeps buffering it before returning a tool result or uploading the Whisper file.

## Impact

A remote endpoint can exhaust worker memory and disrupt unrelated durable runs in the same process.

## Suggested fix

Add conservative configurable byte limits, reject oversized Content-Length early, enforce the bound while streaming chunked bodies, and cancel on overflow.

## Tests

- Oversized declared length
- Chunked response exceeding the cap
- Exactly-at-cap response
- Cancellation and cleanup after overflow

## Dedupe notes

#658 is malformed JSON; #659/#665 are transcription SSRF.
