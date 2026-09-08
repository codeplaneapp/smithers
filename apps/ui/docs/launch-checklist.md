# Launch checklist driver

Run `bun scripts/launch-checklist.ts --target https://your-target.example` from
`apps/ui`. `--dry-run` exercises report generation without network or browser
access. `--out <dir>` selects the report directory.

Each session-cookie identity, including the signed-out identity, gets an isolated
Chrome browser context. Pages are cached per identity for the run. The driver
installs host-only cookies using the explicit target URL, path `/`, Secure and
HttpOnly. It never sets a page-wide Cookie header. Cookies follow browser host
and transport rules on subresources and redirects; they do not authenticate
external hosts or subdomains. Secure cookies require a secure target (subject to
Chrome's localhost exception). Cookie scope does not isolate ports on one host.

The driver connects to Chrome's browser DevTools endpoint and attaches to each
context's page using a flattened CDP session. Socket opening and each CDP request
have a 30-second deadline, configurable through `requestTimeoutMs` in the driver
options. Protocol failures reject with the method, request ID and CDP error code.
Socket close or error rejects all pending requests and subsequent sends.
Evaluation rejects malformed responses and page exceptions; a valid CDP
`undefined` result still returns JavaScript `undefined`.

Each checklist row has a 120-second budget shared by preparation and its probe.
Library callers can set `runChecklist({ rowTimeoutMs, ... })`. Expiry records a
failed row and continues to the next row, even if the probe ignores cancellation.
Ordinary preparation errors remain best-effort evidence. The row signal reaches
fetch, streamed response bodies, browser startup, page calls and sleeps. Custom
probes should use these context methods and `ctx.signal` for additional work.
The signal is also aborted when the row finishes to cancel leftover operations.

The CLI writes JSON and Markdown reports before the first row and after every
completed row through `onProgress`. Reports during a run contain completed rows
only. Earlier results therefore remain on disk while a later row is pending.
The browser is closed in `finally`, including when report writing fails.
