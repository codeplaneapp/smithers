# Wiki collaboration proxy

The existing authenticated platform proxy forwards collaborative wiki traffic to
Plue, including `/api/cloud` requests after their inner path is validated. It
keeps the user's existing session-to-cloud-token bridge and streams upstream SSE
response bodies without buffering them. The editor reconnects with its per-page
`after` query cursor; the proxy does not forward `Last-Event-ID`.

Only `POST /api/repos/{owner}/{repo}/wiki/{slug}/updates` receives a 2 MiB JSON
request envelope, matching Plue's public cap for a base64-encoded 1 MiB binary
Yjs update. Other platform mutations retain their 256 KiB cap. The allowance
matches canonical owner/repository names and lowercase wiki slugs, with no
extra path segments or encoded separators. It applies equally through the
direct and `/api/cloud` routes.

Both declared lengths and streamed byte counts are checked. An oversized stream
is cancelled as soon as its measured body crosses the cap, before forwarding to
Plue. Plue remains responsible for update decoding, rendered document and CRDT
state bounds, page authorization, revision conflicts and durable receipts.

The existing worker tests exercise both route forms with the full binary-update
envelope, ordinary writes and lookalike paths, declared overflow, streamed
overflow and cancellation. Client-error ingestion shares the byte reader and
keeps its existing 16 KiB cap.
