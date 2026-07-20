# 🔒 fix(agents): [high] invalid HTTP-tool baseUrl disables the default-header allowlist

GitHub: https://github.com/smithersai/smithers/issues/801

_via 2026-07 full-codebase audit_

## Summary

An invalid baseUrl is silently ignored while building the generic HTTP tool's header allowlist. With no separate allowedHosts entry, the result is null, meaning default headers are sent to every model-selected destination.

## Where

- `packages/agents/src/http/createHttpTool.js:103-135`

## Failure scenario / repro

Configure baseUrl:"not a valid URL" and defaultHeaders containing an API key, then call an arbitrary local receiver. The receiver obtains the secret.

## Impact

A configuration typo silently converts a host-pinned credential into an unrestricted credential.

## Suggested fix

Fail configuration eagerly when baseUrl is invalid. At minimum return an empty fail-closed allowlist instead of null.

## Tests

- Invalid baseUrl throws or sends no default headers
- Invalid baseUrl plus explicit allowedHosts follows documented policy
- Assert received headers, not only request completion

## Dedupe notes

#658 covers malformed response JSON, not host-policy resolution.
