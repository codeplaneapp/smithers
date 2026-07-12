# Harden API-key web-search providers against redirect leakage

GitHub: https://github.com/smithersai/smithers/issues/1022

Parent: smithers/gh-800-fix-integrations-high-custom-api-key-heade-1i4qvww.md

Context: the audit also found the same automatic redirect behavior in createBraveSearchProvider.js and createSerperSearchProvider.js, which send x-subscription-token and x-api-key. Acceptance criteria: validate every redirect hop, prevent these credentials from reaching another origin, preserve same-origin redirects, and add cross-origin and multi-hop tests for both providers.
