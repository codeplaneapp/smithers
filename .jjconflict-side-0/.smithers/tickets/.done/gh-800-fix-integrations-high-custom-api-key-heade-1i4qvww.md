# 🔒 fix(integrations): [high] custom API-key headers survive cross-origin redirects

GitHub: https://github.com/smithersai/smithers/issues/800

_via 2026-07 full-codebase audit_

## Summary

Several fetch-based clients attach custom secret headers and follow redirects automatically. Bun forwards x-api-key, xi-api-key, and x-subscription-token to a different redirect origin.

## Where

- `packages/agents/src/http/createHttpTool.js:54-75`
- `packages/openapi/src/tool-factory/_helpers.js:208-230`
- `packages/agents/src/web-search/createExaSearchProvider.js:13-25`
- `packages/agents/src/createElevenLabsTextToSpeechTool.js:102-109`
- `apps/review/src/server/proxy/handleAnthropic.ts:166-182`

## Failure scenario / repro

A trusted local server received a secret header and returned a 302 to a second origin. The second server received the secret through generic HTTP, OpenAPI, and Exa repros.

## Impact

Redirects can move operator/provider credentials outside the configured or allowlisted origin.

## Suggested fix

Use manual or validated redirects. Resolve and validate every Location hop and reapply secrets only when the new destination is authorized.

## Tests

- Two-server cross-origin redirects never receive secrets
- Same-origin redirects still work
- Validate every hop in a multi-hop chain

## Dedupe notes

#665 covers transcription redirect SSRF, not credential forwarding across these clients.


> Closed by ticket-fleet sync: All listed clients use manual redirect handling. Generic HTTP rebuilds headers per hop and strips untrusted cross-origin secrets in packages/agents/src/http/createHttpTool.js:67-112,153-180. OpenAPI validates every Location against the service origin or allowlist in packages/openapi/src/tool-factory/_helpers.js:231-290. Exa and ElevenLabs protect x-api-key and xi-api-key in packages/agents/src/web-search/createExaSearchProvider.js:41-83 and packages/agents/src/createElevenLabsTextToSpeechTool.js:148-225. The Anthropic proxy rejects foreign hops and preserves same-origin redirects in apps/review/src/server/proxy/handleAnthropic.ts:43-82. Real two-origin tests cover same-origin, cross-origin, multi-hop, and redirect limits in packages/agents/tests/http-tool-redirects.test.js, packages/openapi/tests/redirect-origin-hardening.test.js, packages/agents/tests/exa-search-redirects.test.js, packages/agents/tests/elevenlabs-tts-redirects.test.js, packages/agents/tests/web-search-redirect-hardening.test.js, and apps/review/tests/server/handleAnthropicRedirects.test.ts. The targeted test run passed 45 tests with 0 failures.
