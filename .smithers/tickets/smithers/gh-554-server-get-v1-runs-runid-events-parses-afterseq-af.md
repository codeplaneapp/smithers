# 🐛 server: GET /v1/runs/:runId/events parses afterSeq after SSE headers are flushed

GitHub: https://github.com/smithersai/smithers/issues/554

**What happens**
In `GET /v1/runs/:runId/events` (packages/server/src/index.js), `res.writeHead(200, ...)` and `res.write("retry: 1000\n\n")` run first (index.js:1088-1095); only then is `parseOptionalInt(url.searchParams.get("afterSeq"), -1)` called (index.js:1097). `parseOptionalInt` throws `HttpError(400)` for non-numeric input (index.js:93-101).

**Why it's wrong / failure scenario**
`GET /v1/runs/<id>/events?afterSeq=abc` → HttpError thrown after headers are flushed → the outer catch (index.js:1326-1339) calls `sendJson`, which calls `res.setHeader` (index.js:309) on a response whose headers are already sent → `ERR_HTTP_HEADERS_SENT` is thrown *inside* the catch and escapes the async request handler as an unhandled rejection. The client is left holding a 200 SSE stream that never produces events, instead of receiving a 400.

**Expected**
Parse/validate `afterSeq` before `writeHead`.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
