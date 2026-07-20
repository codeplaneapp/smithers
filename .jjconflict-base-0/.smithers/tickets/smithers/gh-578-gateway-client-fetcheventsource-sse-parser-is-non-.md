# 🧹 gateway-client: fetchEventSource SSE parser is non-spec-conformant (first data: line only, space required)

GitHub: https://github.com/smithersai/smithers/issues/578

**What happens**
The hand-rolled SSE parser in `packages/gateway-client/src/data/createSmithersDataClient.ts:201-204` processes each frame with `lines.find((line) => line.startsWith("data: "))?.slice(6)` (and the same pattern for `event: `).

**Why it's a trap**
The SSE spec allows multiple `data:` lines per event (joined with `\n`) and `data:foo` with no space after the colon. Both are silently mangled: multi-line payloads truncate to the first line, no-space fields drop entirely and fall back to `"{}"`. This works today only because the smithers gateway emits single-line `data: {...}` frames with a space; any spec-conformant server-side change (or a proxy that reframes) breaks the parser silently.

**Expected**
Either make the parser spec-conformant (accumulate all `data:` lines, tolerate the optional space, handle CRLF), or pin the gateway's framing as a documented contract next to this code so neither side drifts.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
