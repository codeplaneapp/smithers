# Prevent cross-origin Anthropic key forwarding in the review proxy

GitHub: https://github.com/smithersai/smithers/issues/918

Harden apps/review/src/server/proxy/handleAnthropic.ts and its upstream fetch path so the injected Anthropic x-api-key cannot follow an unauthorized Location response. Validate each redirect destination against the configured upstream origin or explicit allowlist, preserve authorized redirects, and add real fixture tests for cross-origin, same-origin, and multi-hop redirects.


> Closed by ticket-fleet sync: apps/review/src/server/proxy/handleAnthropic.ts manually follows redirects, resolves every Location, requires each destination to match the configured upstream origin, and returns 502 before fetching cross-origin targets. It preserves same-origin redirect semantics and caps redirects at five. apps/review/tests/server/handleAnthropicRedirects.test.ts uses two real Bun.serve fixtures and covers cross-origin refusal with no foreign request, same-origin 307 preservation, same-origin 302 POST-to-GET behavior, and a five-hop redirect loop. The test passes with 4 tests and 0 failures; apps/review typecheck also succeeds.
