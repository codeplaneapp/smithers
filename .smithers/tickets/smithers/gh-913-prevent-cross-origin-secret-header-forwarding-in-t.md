# Prevent cross-origin secret-header forwarding in the generic HTTP tool

GitHub: https://github.com/smithersai/smithers/issues/913

Harden packages/agents/src/http/createHttpTool.js so default headers and request auth cannot reach an unauthorized redirect destination. Use manual or validated redirect handling, preserve secrets for authorized same-origin or explicitly allowed destinations, validate every Location hop, and add real two-server tests covering cross-origin redirects, same-origin redirects, and multi-hop chains.
