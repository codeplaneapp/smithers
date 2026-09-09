# Onboarding answers

`POST https://bug.smithers.sh/api/onboarding-answers` accepts `{ id, heard, project }`.
`id` is a browser-generated UUID retained for retries. Answers are optional strings
up to 500 characters each; an empty form skips the request. The UI submits on
Continue, after disclosing that answers are shared with the Smithers team.
Draft edits stay local until then. A failed save keeps the form open for retry.

Answers live in the existing Cloudflare KV binding `BUGS`, under `onboarding:<id>`.
Records contain the two answers and a server-generated `receivedAt` timestamp.
There is no expiry and no public read endpoint. Resetting the local app does not
delete responses already submitted. No identity is inferred from anonymous answers.

Review in Cloudflare: Workers & Pages → the deployed bug Worker → Bindings →
BUGS → KV entries, filter `onboarding:`. The live Worker is named
`smithers-bug-worker-smithers-bug-worker-williamcory`.

For JSON export, GET the same endpoint with the existing `x-bug-admin` operator
secret. The response is `{ answers, cursor }`, 100 records per page. Pass a non-null
cursor as `?cursor=...` until it is null. Reads use `cache-control: no-store` and
unauthorized reads return 404. KV list/read propagation is eventually consistent.

The intake enforces an 8KB streamed body cap and the existing best-effort KV
per-IP limit (20 submissions/hour, separately keyed for onboarding). Retries
replace the same UUID record. Cloudflare API credentials and the operator secret
must never be bundled into the browser.
