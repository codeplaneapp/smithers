# Prevent cross-origin Anthropic key forwarding in the review proxy

GitHub: https://github.com/smithersai/smithers/issues/918

Harden apps/review/src/server/proxy/handleAnthropic.ts and its upstream fetch path so the injected Anthropic x-api-key cannot follow an unauthorized Location response. Validate each redirect destination against the configured upstream origin or explicit allowlist, preserve authorized redirects, and add real fixture tests for cross-origin, same-origin, and multi-hop redirects.
