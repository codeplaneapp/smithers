# api/

Pure serializers that turn raw DB rows (snake_case keys, driver-typed values)
into the stable camelCase wire rows served by the Gateway HTTP/Electric
collection endpoints. `apiCollectionNames.ts` lists the served collection
names.

How it fits together:

- `normalizeApiRow.ts` (internal — not re-exported from `index.ts`) does the
  shared work: snake→camel keys, and bigint→number (or a decimal string when
  the value is not a safe integer).
- Each `serializeXRow.ts` then pins the exact wire shape for one collection —
  picking fields, defaulting missing ones, and parsing embedded JSON columns
  (e.g. approval `request_json`, run-event `payload_json`).
- One `serializeXRow` exists per collection even when it is a bare
  `normalizeApiRow` pass-through (account/prompt/workflow): a deliberate
  family, so every collection has a named seam to pin its shape later.

Consumers: `packages/server/src/gateway.js` and `packages/gateway-client`
(whose `mapSmithersElectricRow` plus the electric-row-parity and
local-import-boundary tests assert parity), so the output shapes are contract,
not implementation detail.
