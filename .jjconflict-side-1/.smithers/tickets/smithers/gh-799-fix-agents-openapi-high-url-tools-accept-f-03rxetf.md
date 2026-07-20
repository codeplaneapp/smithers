# 🔒 fix(agents/openapi): [high] URL tools accept file:// and expose local files under Bun

GitHub: https://github.com/smithersai/smithers/issues/799

_via 2026-07 full-codebase audit_

## Summary

The generic HTTP tool and generated OpenAPI tools accept non-HTTP URL schemes. Under Bun, fetch(file://...) succeeds, so agent-controlled arguments or an untrusted OpenAPI server URL can read host-local files.

## Where

- `packages/agents/src/http/createHttpTool.js:9-12,47,75`
- `packages/openapi/src/tool-factory/_helpers.js:61-82,230`

## Failure scenario / repro

Calling the generic tool with file:///etc/hosts and executeRequest with baseUrl file:///etc both returned local host-file contents on current main.

## Impact

Credentials, configuration, source, and other host-local data can be exposed to the model and caller.

## Suggested fix

Require http: or https: before every fetch and reject all other schemes with a typed tool error. Consider a destination-host policy for the generic HTTP tool as separate defense in depth.

## Tests

- Reject file:, data:, and other non-HTTP schemes in both surfaces
- Preserve normal HTTP/HTTPS execution
- Run under Bun where file fetch currently succeeds

## Dedupe notes

#658 concerns malformed JSON; #659/#665 are transcription-specific SSRF issues.
