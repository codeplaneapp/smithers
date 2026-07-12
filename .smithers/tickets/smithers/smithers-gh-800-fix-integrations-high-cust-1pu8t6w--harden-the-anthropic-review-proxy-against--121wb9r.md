# Harden the Anthropic review proxy against upstream-key leakage

GitHub: https://github.com/smithersai/smithers/issues/1021

Parent: smithers/gh-800-fix-integrations-high-custom-api-key-heade-1i4qvww.md

Context: apps/review/src/server/proxy/handleAnthropic.ts injects env.ANTHROPIC_API_KEY before calling the configured upstream. Acceptance criteria: manually follow or validate redirects against the configured Anthropic upstream origin at every hop, never expose the injected key cross-origin, preserve authorized redirects and streaming behavior, and add two-server redirect tests.
