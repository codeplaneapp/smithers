# linear/

The Linear integration surface:

- `LinearClient.js` — plain-fetch GraphQL client as an Effect service
  (`Context.Service` `LinearClient` + `LinearClientLive` layer): per-client caches
  for team/workflow-state/label lookups, `ENG-123` identifier resolution,
  429/5xx retry honoring rate-limit headers. No `@linear/sdk` dependency —
  behaviors are ports of eliza plugin-linear over raw GraphQL.
- `LinearWebhookSource.js` — `Linear-Signature` HMAC verification plus a
  `webhookTimestamp` freshness check, then per-(name, correlation) fan-out.
- `components.js` — listener components (Signal.js pattern over
  `WaitForEvent`) and outbound compute Tasks (`CreateIssue`, `UpdateIssue`,
  `CommentOnIssue`).
- `schemas.js` — zod `looseObject` payload/output schemas: typed core
  fields, everything else passes through.
- `config.js` — explicit config → `configureLinear` registry →
  `SMITHERS_LINEAR_*` env vars.

Correlation variants per delivery: issue identifier (`ENG-123`), team key
(`ENG`), and null — each emitted as its own signal with its own dedupeKey
suffix, because `findRunsAwaitingEvent` matches (eventName, correlationId)
exactly.

API-key hygiene: the key goes only into the Authorization header (personal
keys raw, OAuth tokens pre-prefixed), never into errors or logs.
