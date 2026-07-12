# Harden Exa search redirects against API-key leakage

GitHub: https://github.com/smithersai/smithers/issues/1019

Parent: smithers/gh-800-fix-integrations-high-custom-api-key-heade-1i4qvww.md

Context: packages/agents/src/web-search/createExaSearchProvider.js sends x-api-key through an automatically-followed fetch. Acceptance criteria: ensure x-api-key is never sent to a cross-origin redirect, validate every Location hop, preserve same-origin redirects, and add two-server tests covering cross-origin, same-origin, and multi-hop chains.


> Closed by ticket-fleet sync: packages/agents/src/web-search/createExaSearchProvider.js:53-83 manually follows redirects with redirect:"manual", resolves and validates every Location against the current origin, rejects cross-origin hops before issuing a request, preserves same-origin hops, and caps loops. packages/agents/tests/exa-search-redirects.test.js:19-68 creates real Exa and attacker servers; tests at lines 85-118 cover same-origin, multi-hop same-origin, direct cross-origin, later-hop cross-origin, and redirect loops. bun test packages/agents/tests/exa-search-redirects.test.js passed: 5 pass, 0 fail.
