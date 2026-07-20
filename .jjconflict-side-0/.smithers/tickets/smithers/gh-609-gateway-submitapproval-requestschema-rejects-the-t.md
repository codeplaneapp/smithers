# 🐛 gateway: submitApproval requestSchema rejects the top-level `note` field the TS type declares and the server honors

GitHub: https://github.com/smithersai/smithers/issues/609

**What happens**
- `packages/gateway/src/rpc/index.ts:164-175` — `SubmitApprovalRequest` includes a top-level `note?: string`.
- `packages/server/src/gateway.js:6605` — the server reads it: `const note = asString(params.note) ?? asString(stableDecision?.note)` and passes it to approveNode/denyNode.
- `packages/gateway/src/rpc/index.ts:717-727` — the `submitApproval` `requestSchema` lists only `runId`, `nodeId`, `iteration`, `approved`, `decision`, and `objectSchema` defaults to `additionalProperties: false` (rpc/index.ts:493).

**Why it's wrong / failure scenario**
The published JSON-Schema contract — and the generated `openapi.yaml` — declares a request carrying top-level `note` invalid, even though it is legal per the exported TS type and honored by the server. Any client or generated SDK that validates against the schema strips or rejects the note; any strict server-side validation adopted later would break existing callers.

**Expected behavior**
`requestSchema` includes an optional `note` string property; regenerate `openapi.yaml`.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
