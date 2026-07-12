# Harden generic HTTP tool redirects against secret-header leakage

GitHub: https://github.com/smithersai/smithers/issues/1017

Parent: smithers/gh-800-fix-integrations-high-custom-api-key-heade-1i4qvww.md

Context: packages/agents/src/http/createHttpTool.js sends caller headers, auth headers, and configured default headers through fetch. Acceptance criteria: resolve every Location hop manually or equivalently; preserve secrets only for the original authorized origin or configured allowlist; never forward secret headers cross-origin; preserve same-origin redirects; add real two-server tests for cross-origin, same-origin, and multi-hop redirects.
