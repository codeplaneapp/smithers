# Prevent cross-origin credential leakage in OpenAPI tool execution

GitHub: https://github.com/smithersai/smithers/issues/914

Harden packages/openapi/src/tool-factory/_helpers.js executeRequest so injected bearer, basic, API-key, and custom headers are not forwarded across unauthorized redirects. Define the authorized destination policy from the configured API origin and any explicit allowlist, validate each redirect hop, and add tests for cross-origin, same-origin, and multi-hop redirects.


> Closed by ticket-fleet sync: Implemented in packages/openapi/src/tool-factory/_helpers.js: fetchWithRedirectValidation builds an origin policy from the request URL and allowedRedirectOrigins, validates every redirect hop, and blocks unauthorized destinations before fetching. Tests in packages/openapi/tests/redirect-origin-hardening.test.js cover bearer, API-key, custom headers, cross-origin refusal, same-origin redirects, multi-hop redirects, allowlisting, query-key redaction, method rewriting, and redirect limits. The package test suite passed: 192 tests, 0 failures; package typecheck also passed.
