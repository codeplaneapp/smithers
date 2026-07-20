# Harden Exa search provider redirect handling

GitHub: https://github.com/smithersai/smithers/issues/915

Update packages/agents/src/web-search/createExaSearchProvider.js to prevent x-api-key from being sent to an unauthorized redirect origin. Preserve valid same-origin redirects, validate every Location hop, and add a two-server regression test proving the key is absent from cross-origin targets and retained for authorized redirects.


> Closed by ticket-fleet sync: Implemented in packages/agents/src/web-search/createExaSearchProvider.js:41-88: redirects are manual, every Location is resolved and origin-checked, same-origin hops retain credentials, and cross-origin hops fail before forwarding x-api-key. packages/agents/tests/exa-search-redirects.test.js:19-118 provides a two-server regression suite covering same-origin retention, multi-hop validation, cross-origin rejection, and redirect loops. bun test packages/agents/tests/exa-search-redirects.test.js passes all 5 tests.
