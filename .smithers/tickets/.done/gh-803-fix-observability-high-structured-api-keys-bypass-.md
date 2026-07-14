# 🔒 fix(observability): [high] structured API keys bypass trace redaction and reach OTLP

GitHub: https://github.com/smithersai/smithers/issues/803

_via 2026-07 full-codebase audit_

## Summary

Trace redaction serializes structured values and applies value-pattern regexes, but does not redact values based on secret-bearing object keys. Common credentials remain in agent traces and exported observability payloads.

## Where

- `apps/observability/src/_traceRedaction.js:5-70`
- `packages/engine/src/AgentTraceCollector.js:516-550,637-672`
- `apps/observability/src/_otelLogBuilders.js:42-50`

## Failure scenario / repro

Objects containing x-api-key, github_token, and TELEGRAM_BOT_TOKEN returned applied:false with plaintext unchanged, then survived OTLP serialization.

## Impact

Provider keys and bot tokens can enter trace artifacts, logs, and OTLP backends with broader access than credential stores.

## Suggested fix

Traverse structured values before serialization, canonicalize keys case-insensitively, and redact authorization/cookie/API-key/token/password/secret fields. Keep value-pattern rules as defense in depth.

## Tests

- Cover nested objects and arrays, mixed casing, hyphens/underscores, and common vendor token formats
- Verify non-secret metadata remains intact

## Dedupe notes

#457 fixed specific value formats; this is the remaining structured-key gap.


> Closed by ticket-fleet: landed on main in 56af962ec3791a929eabf9cc00c1e7262f18c67f.
