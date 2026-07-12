# proxy/

The metered Anthropic proxy. Its provider-key egress allowlist is POST-only:
`/anthropic/v1/messages` and `/anthropic/v1/messages/count_tokens`.

- `handleAnthropic.ts` — authenticate, enforce the per-session and per-repo
  monthly spend caps, forward with the real API key, stream the response back
  unmodified, and meter from a teed copy via `waitUntil`.
- `authenticateProxyRequest.ts` — resolves session tokens (the hot path) and
  then `srk_` api keys.
- `parseUsageFromJson.ts` / `parseUsageFromSse.ts` — extract token usage from
  the response body (the SSE parser handles CRLF frames).
- `spendReservations.ts` — estimates a Messages call from request bytes and
  `max_tokens`, rejects provider features without bounded static accounting,
  then atomically reserves both session and repository capacity.
- `recordUsage.ts` — atomically appends `usage_events`, increments `spent_usd`,
  and removes the settled reservation in one transactional D1 batch.
- `modelPrices.ts` — shared price lookup plus the stricter request-model
  allowlist; response-only unknowns use `recordUsage.ts`'s high-rate fallback.
- `parseUsage.ts` — the shared `UsageSummary` type.

Reservation semantics: one conditional D1 `INSERT` considers recorded spend
plus all active leases, closing the concurrent-read admission race. A complete
2xx response settles at measured usage and releases unused capacity. A client
cancellation, transport truncation, bodyless success, or parser miss settles at
the full conservative estimate; a non-2xx response or failed upstream dispatch
releases it. Leases expire after two hours and are pruned on later admissions,
so a Worker crash cannot strand capacity forever. Settlement uses D1's
transactional `batch()`: a failed accounting statement rolls the whole batch
back and leaves the lease active (fail closed) until a retry or expiry.

Only request models with a nonzero static price are dispatched upstream. The
cautious high-rate fallback in `recordUsage.ts` is intentionally narrower: it
covers a provider response that names a different/unknown model, but it is not
an allowlist for sending new request models whose future price could exceed the
current table.

The proxy accepts standard/global Messages billing with ordinary client-side
tools and five-minute prompt caching. It writes `service_tier: standard_only`
and `inference_geo: global` into creation requests when clients omit them, so
workspace defaults cannot silently select premium capacity or geography.
Client-tool and rich-content requests are sent through Anthropic's free token
counting endpoint before admission; the reservation doubles that estimate and
adds a fixed safety allowance because provider counts can differ slightly from
final usage. Mutable URL-backed content is rejected because it could change
between counting and creation. Fast mode, US-only inference, explicit priority
selection, typed server-side tools, MCP servers, container reuse, and
non-five-minute cache TTLs are also rejected before dispatch because their
premiums, remote expansion, or per-use charges are not fully bounded by the
token-only reservation ledger.
