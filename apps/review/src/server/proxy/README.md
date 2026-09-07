# proxy/

The metered Anthropic proxy (`POST /anthropic/v1/messages` only).

- `handleAnthropic.ts` — authenticate, enforce the per-session and per-repo
  monthly spend caps, forward with the real API key, stream the response back
  unmodified, and meter from a teed copy via `waitUntil`.
- `anthropicEndpointAllowed.ts` — the method/path allowlist. The forwarded
  request carries the service-wide key, and Anthropic's file and batch APIs are
  workspace-scoped, so a `/v1/` prefix check would let any repo-scoped caller
  read and delete another tenant's objects.
- `authenticateProxyRequest.ts` — resolves session tokens (the hot path) and
  then `srk_` api keys.
- `parseUsageFromJson.ts` / `parseUsageFromSse.ts` — extract token usage from
  the response body (the SSE parser handles CRLF frames).
- `recordUsage.ts` — appends `usage_events` and increments `spent_usd`
  UNCONDITIONALLY; the cap is enforced pre-flight (see the comment on the
  audit-log undercounting bug that conditional updates caused).
- `modelPrices.ts` — static per-model price table; unknown models meter at $0
  but still record tokens.
- `parseUsage.ts` — the shared `UsageSummary` type.

Gotchas: metering misses on 2xx `/v1/messages` responses are logged loudly;
api-key (operator) requests bypass the session and monthly caps; adding an
endpoint to the allowlist needs a justification for both cross-tenant isolation
and metering.
