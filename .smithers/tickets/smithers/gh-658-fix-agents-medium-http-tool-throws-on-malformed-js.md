# 🐛 fix(agents): [medium] HTTP tool throws on malformed JSON response bodies

GitHub: https://github.com/smithersai/smithers/issues/658

via /codex review

**Severity:** Medium

## Problem
`createHttpTool` promises an `HttpToolOutput` envelope with `ok`, HTTP status, headers, and body, but `parseResponseBody()` unconditionally `JSON.parse`s any response whose `Content-Type` contains `application/json`. A gateway, proxy, or upstream API can return a non-2xx response with a mislabeled or truncated JSON body, and the tool throws a raw `SyntaxError` before returning the HTTP status/body envelope.

## References
- `packages/agents/src/http/createHttpTool.js:75` performs the fetch.
- `packages/agents/src/http/createHttpTool.js:76` starts building the output envelope.
- `packages/agents/src/http/createHttpTool.js:81` awaits `parseResponseBody(response)` before returning the envelope.
- `packages/agents/src/http/createHttpTool.js:199` checks `content-type`.
- `packages/agents/src/http/createHttpTool.js:201` calls `JSON.parse(text)` unguarded.

## Failure Scenario
A REST API returns:

- status: `502 Bad Gateway`
- header: `Content-Type: application/json`
- body: `{bad`

Actual result:

```text
SyntaxError: Expected property name or '}' in JSON at position 1
```

The agent never receives `{ ok: false, status: 502, statusText: "Bad Gateway", headers, body }`, so it cannot inspect the upstream status, see the raw error payload, or decide whether to retry/fallback.

I verified this by stubbing `globalThis.fetch` to return that response and calling `createHttpTool().execute({ method: "GET", url: "https://api.example.test" })`; the promise rejects with `SyntaxError`.

## Why It Matters
The generic HTTP tool is the escape hatch for arbitrary REST APIs. Invalid or mislabeled JSON error bodies are common during outages and proxy failures. Throwing before returning the HTTP envelope violates the tool contract and turns an ordinary upstream HTTP failure into an agent/tool execution failure.

A safer behavior would catch JSON parse failures and return the raw text (or a structured parse-error wrapper) while preserving the HTTP status and headers.

