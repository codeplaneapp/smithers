# github/

The GitHub integration surface:

- `GitHubClient.js` — Effect Context.Tag REST client: rate-limit-aware
  retries (honors `Retry-After` / `x-ratelimit-reset`, capped at 60s),
  Link-header pagination, optional Effect Schema decoding per request.
- `GitHubWebhookSource.js` — `X-Hub-Signature-256` verification and
  per-(name, correlation) event fan-out (`decodeGitHubWebhook`).
- `config.js` — credential resolution: explicit config → `configureGitHub`
  registry → env (`SMITHERS_GITHUB_TOKEN`/`GITHUB_TOKEN`, ...).
- `schemas.js` — zod passthrough payload/output schemas: typed core fields,
  everything else passes through so real deliveries are never rejected.
- `components/` — listener and outbound workflow components (see its README).

Fan-out invariant: one webhook delivery emits one ExternalEvent per name
variant (base + `.action`) × correlation variant (`owner/repo#N`,
`owner/repo`, null) because `findRunsAwaitingEvent` matches signal name +
correlationId exactly; dedupeKeys embed the variant so redeliveries dedupe
per variant.

Token hygiene: the token only ever reaches the Authorization header — never
error messages, logs, or details.
