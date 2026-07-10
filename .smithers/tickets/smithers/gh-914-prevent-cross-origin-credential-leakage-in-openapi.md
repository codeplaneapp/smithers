# Prevent cross-origin credential leakage in OpenAPI tool execution

GitHub: https://github.com/smithersai/smithers/issues/914

Harden packages/openapi/src/tool-factory/_helpers.js executeRequest so injected bearer, basic, API-key, and custom headers are not forwarded across unauthorized redirects. Define the authorized destination policy from the configured API origin and any explicit allowlist, validate each redirect hop, and add tests for cross-origin, same-origin, and multi-hop redirects.
