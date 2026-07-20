# Harden OpenAPI tool redirects against auth-header leakage

GitHub: https://github.com/smithersai/smithers/issues/1018

Parent: smithers/gh-800-fix-integrations-high-custom-api-key-heade-1i4qvww.md

Context: packages/openapi/src/tool-factory/_helpers.js injects operator authentication and calls fetch directly. Acceptance criteria: validate every redirect destination against the configured OpenAPI service origin or allowlist; prevent injected API-key and authorization headers from reaching another origin; preserve authorized same-origin redirects; add cross-origin, same-origin, and multi-hop tests.
