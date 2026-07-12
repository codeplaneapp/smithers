# Harden Exa search redirects against API-key leakage

GitHub: https://github.com/smithersai/smithers/issues/1019

Parent: smithers/gh-800-fix-integrations-high-custom-api-key-heade-1i4qvww.md

Context: packages/agents/src/web-search/createExaSearchProvider.js sends x-api-key through an automatically-followed fetch. Acceptance criteria: ensure x-api-key is never sent to a cross-origin redirect, validate every Location hop, preserve same-origin redirects, and add two-server tests covering cross-origin, same-origin, and multi-hop chains.
