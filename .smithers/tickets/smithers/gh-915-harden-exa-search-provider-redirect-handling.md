# Harden Exa search provider redirect handling

GitHub: https://github.com/smithersai/smithers/issues/915

Update packages/agents/src/web-search/createExaSearchProvider.js to prevent x-api-key from being sent to an unauthorized redirect origin. Preserve valid same-origin redirects, validate every Location hop, and add a two-server regression test proving the key is absent from cross-origin targets and retained for authorized redirects.
