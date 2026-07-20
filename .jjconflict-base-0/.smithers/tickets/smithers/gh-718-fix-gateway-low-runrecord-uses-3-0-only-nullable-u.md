# 🐛 fix(gateway): [low] runRecord uses 3.0-only `nullable` under an OpenAPI 3.1.0 spec, so getRun's null startedAtMs/finishedAtMs break strict clients

GitHub: https://github.com/smithersai/smithers/issues/718

_via ultracode (Opus multi-agent) review_

## Summary
The generated Gateway contract declares `openapi: 3.1.0` but marks `runRecord.startedAtMs`/`finishedAtMs` nullable with the 3.0-only `nullable: true` keyword, which 3.1 tooling ignores — so these optional fields validate as non-nullable integers and reject the null the server actually sends.

## Locations
- `packages/gateway/scripts/generate-openapi.ts:332` — emits `openapi: "3.1.0"` and serializes schemas verbatim (no nullable→type-array transform).
- `packages/gateway/src/rpc/index.js:188-189` — `startedAtMs`/`finishedAtMs` declared `{ ...integerSchema(...), nullable: true }`; neither is in `required` (only `runId`).
- `packages/gateway/openapi.yaml:3771-3780` — generated output: `type: integer` + `nullable: true` under the 3.1.0 doc.
- Correct form already used everywhere else in the same file: `type: ["integer","null"]` at `rpc/index.js:466, 515, 674`, etc.
- `packages/db/src/adapter/RunRow.ts:9` types `startedAtMs: number | null`; DB column (`internal-schema/smithersRuns.js:10`) is nullable — the server genuinely produces null pre-start/finish.

## Failure scenario
`getRun` returns a run that hasn't started/finished; the Gateway sends `startedAtMs: null` / `finishedAtMs: null`. In OpenAPI 3.1 (JSON Schema 2020-12) `nullable` was removed and is an ignored unknown keyword, so a 3.1-compliant client/response-validator generated from `openapi.yaml` treats these as `type: integer` and rejects the null.

## Why it matters
The published contract disagrees with real server responses for a stable RPC (`getRun`), breaking strict consumers on legitimate nulls. Fix is trivial and consistency-restoring: replace `nullable: true` with the `type: ["integer","null"]` form already used for every other nullable field. (`anyJsonSchema`'s `nullable: true` at 142/145 is merely redundant — its `oneOf` already has a `{ type: "null" }` branch — but should be dropped for consistency.)
