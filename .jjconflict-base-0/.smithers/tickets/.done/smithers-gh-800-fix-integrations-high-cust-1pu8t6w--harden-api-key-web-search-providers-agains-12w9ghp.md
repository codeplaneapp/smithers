# Harden API-key web-search providers against redirect leakage

GitHub: https://github.com/smithersai/smithers/issues/1022

Parent: smithers/gh-800-fix-integrations-high-custom-api-key-heade-1i4qvww.md

Context: the audit also found the same automatic redirect behavior in createBraveSearchProvider.js and createSerperSearchProvider.js, which send x-subscription-token and x-api-key. Acceptance criteria: validate every redirect hop, prevent these credentials from reaching another origin, preserve same-origin redirects, and add cross-origin and multi-hop tests for both providers.


> Closed by ticket-fleet sync: Implemented in commit 25ad3819a6. Both createBraveSearchProvider.js and createSerperSearchProvider.js manually validate every redirect hop against the initial origin, reject cross-origin redirects before issuing a request, and preserve same-origin redirects. packages/agents/tests/web-search-redirect-hardening.test.js covers both providers' same-origin, cross-origin, and multi-hop behavior. Targeted test run passed: 9 tests, 0 failures.
