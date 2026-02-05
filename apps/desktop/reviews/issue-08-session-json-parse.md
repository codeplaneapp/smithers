# getSession can throw on corrupt message JSON

Severity: Low

Location: `src/bun/db.ts:203`

Description:
`getSession` parses all message JSON without a try/catch. A single corrupt row can throw and prevent session loading.

Impact:
One bad row can break viewing a session and degrade UX.

Suggested Fix:
Wrap JSON parsing in a try/catch and skip or log invalid rows, consistent with `listSessionMessages` behavior.
