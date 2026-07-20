# Harden generic HTTP tool redirects against secret-header leakage

GitHub: https://github.com/smithersai/smithers/issues/1017

Parent: smithers/gh-800-fix-integrations-high-custom-api-key-heade-1i4qvww.md

Context: packages/agents/src/http/createHttpTool.js sends caller headers, auth headers, and configured default headers through fetch. Acceptance criteria: resolve every Location hop manually or equivalently; preserve secrets only for the original authorized origin or configured allowlist; never forward secret headers cross-origin; preserve same-origin redirects; add real two-server tests for cross-origin, same-origin, and multi-hop redirects.


> Closed by ticket-fleet sync: Commit 3c0bbafe5b (🔒 fix: Harden generic HTTP tool redirects against secret-header leakage, closes #1017) is an ancestor of main. packages/agents/src/http/createHttpTool.js manually resolves all HTTP(S) Location hops, rebuilds headers per hop, preserves secrets only on the original origin or configured allowlisted hosts, and strips headers on untrusted cross-origin hops. packages/agents/tests/http-tool-redirects.test.js uses two real Bun servers and covers same-origin, cross-origin stripping, multi-hop redirects, allowlisted targets, attacker bouncing, method/body semantics, and redirect limits. The targeted test passed: 9 tests, 0 failures.
