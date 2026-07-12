# Harden the Anthropic review proxy against upstream-key leakage

GitHub: https://github.com/smithersai/smithers/issues/1021

Parent: smithers/gh-800-fix-integrations-high-custom-api-key-heade-1i4qvww.md

Context: apps/review/src/server/proxy/handleAnthropic.ts injects env.ANTHROPIC_API_KEY before calling the configured upstream. Acceptance criteria: manually follow or validate redirects against the configured Anthropic upstream origin at every hop, never expose the injected key cross-origin, preserve authorized redirects and streaming behavior, and add two-server redirect tests.


> Closed by ticket-fleet sync: apps/review/src/server/proxy/handleAnthropic.ts:52-79 manually follows redirects with redirect:"manual", checks every hop against the configured origin, preserves authorized redirect semantics, and caps loops. Lines 214-239 inject the key only after constructing the request and fail closed before cross-origin hops. apps/review/tests/server/handleAnthropicRedirects.test.ts:65-93 uses two real servers to verify the foreign server receives no request or key; lines 95-131 verify same-origin 307 streaming, method/body preservation, and metering; lines 133-157 verify 302 POST-to-GET behavior; lines 159-175 verify the hop cap. bun test apps/review/tests/server/handleAnthropicRedirects.test.ts passed 4 tests with 0 failures.
