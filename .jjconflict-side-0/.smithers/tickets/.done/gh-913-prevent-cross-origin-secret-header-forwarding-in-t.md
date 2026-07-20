# Prevent cross-origin secret-header forwarding in the generic HTTP tool

GitHub: https://github.com/smithersai/smithers/issues/913

Harden packages/agents/src/http/createHttpTool.js so default headers and request auth cannot reach an unauthorized redirect destination. Use manual or validated redirect handling, preserve secrets for authorized same-origin or explicitly allowed destinations, validate every Location hop, and add real two-server tests covering cross-origin redirects, same-origin redirects, and multi-hop chains.


> Closed by ticket-fleet sync: packages/agents/src/http/createHttpTool.js:67-112 manually resolves every redirect with redirect:"manual", validates HTTP(S) Location targets, and rebuilds headers per hop. Lines 153-180 preserve headers/auth only for the original origin or allowlisted hosts; unauthorized cross-origin hops receive no headers. packages/agents/tests/http-tool-redirects.test.js:7-18 uses two real Bun servers and lines 118-185 cover same-origin, cross-origin, multi-hop, and allowlisted redirects, including secret auth/default/caller headers. The dedicated test passed: 9 pass, 0 fail.
