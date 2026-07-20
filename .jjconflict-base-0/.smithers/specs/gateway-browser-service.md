# Gateway browser service: shared live browser sessions

One browser service on the per-repo gateway, two consumers: the apps/smithers
PWA (see `agentic-browsing.md`) and Smithers Code (multi repo, `SPEC.md` §12).
Both products embed a stationary viewer onto a real Chromium that runs beside
the gateway; the user and the agent drive the same ordered session. This spec
is the gateway-side contract. Client UI belongs to each consumer.

## Relationship to agentic-browsing.md

That spec's architecture stands: viewer-not-site, CDP screencast over the
existing gateway WS, accessibility-tree perception, untrusted-page-content
rule, human-in-the-loop login, kill switch. Two amendments, both decided:

1. **No provider rental.** Phase 0 (Browserbase/Steel) is superseded. The
   runtime is gateway-local Chromium via Playwright: in production the
   per-repo gateway already runs inside the sandbox VM, so gateway-local IS
   in-sandbox, and dev servers on the VM's loopback are reachable natively.
   Locally it is the workspace gateway plus a headless Chromium resolved the
   same way the UI tests resolve it (createRequire against a package that
   declares the playwright dep).
2. **Sessions are first-class, not run-scoped.** Smithers Code drives
   sessions from chat with no workflow run attached. A `BrowserSession` has
   its own id and lifecycle; a run MAY attach to one, and a session outlives
   the viewer that shows it.

## Session model

- `sessionId`: opaque, server-issued. Scoped to the workspace/repo the
  gateway serves. Unauthorized and nonexistent are indistinguishable.
- Snapshot (JSON, serializable): `{ sessionId, source, status, revision,
  page: { url, title, canGoBack, canGoForward } | null, viewport,
  control: { owner: "user" | "agent" | null } }`.
  `source` is `{ kind: "url", url }` or `{ kind: "dev-server", port, path }`.
  `status`: starting | ready | loading | suspended | closed | failed.
- **Revision**: one settled external action increments one monotonic
  `revision`. It is the optimistic-concurrency fence for actions and the
  staleness fence for selections. DOM mutation ticks never increment it.
- **Action dedupe**: every mutating call carries a caller-created `actionId`
  and optional `expectedRevision`. Replaying a seen `actionId` returns the
  prior outcome without re-executing. A stale `expectedRevision` returns a
  `REVISION_CONFLICT` error; the caller must re-pull context.
- **Journal**: ordered semantic events, actor-tagged (`user | agent | page`),
  coalesced (a click plus its redirects is one entry; text entry settles on
  commit/blur with sensitive fields recorded as redacted; scroll settles to
  one debounced position). Raw input, wheel ticks, DOM mutations, and console
  lines are never journal entries; they are queryable via context.
- **Quotas** (defaults, config-overridable): 10 min idle TTL, 2 h hard
  lifetime, 2 concurrent sessions per workspace, screenshot artifacts
  retained 7 days. Closing the viewer never closes the session; TTL, quota,
  or an explicit close does.
- **Profile**: fresh ephemeral browser context per session. No ambient
  cookies, no persistence across sessions. Wiped on close.

## Protocol surface

The closed protocol below is the ONLY browser control surface. Raw CDP is
never exposed to any client (no file:// navigation, no download control, no
protocol passthrough). Playwright drives Chromium inside the service.

New gateway RPC methods (each must follow the full "Adding a run status or
gateway RPC method" checklist in the dev gotchas: rpc-contract.test.ts,
GatewayRpcTypeMap, client convenience methods, regenerated openapi.yaml and
gateway d.ts, docs/rpc/<kebab>.mdx with the versioned-errors sentence,
check-docs counts, docs:llms regen):

- `createBrowserSession { source, viewport? }` returns the snapshot.
  Rejects when the workspace quota is reached.
- `browserAct { sessionId, actionId, expectedRevision?, action }` where
  `action` is the discriminated union: `{ kind: "navigate", url }`,
  `{ kind: "back" | "forward" | "reload" | "stop" }`,
  `{ kind: "click", locator?, point?, button?, modifiers? }`,
  `{ kind: "type", locator, text, replace? }`,
  `{ kind: "press", key, modifiers? }`,
  `{ kind: "scroll", deltaX, deltaY }`,
  `{ kind: "dialog", decision, promptText? }`.
  Returns `{ revision, page, outcome }` after settlement.
- `browserContext { sessionId, sinceRevision?, include? }` returns a bounded
  fresh snapshot. `include` selects: visible-text, accessibility,
  interactive-elements (with locators), screenshot (artifact ref, never
  base64), selections, recent-actions, console-summary, network-summary.
  Server-enforced maxima on every collection and string. A snapshot the
  service cannot capture returns `fresh: false` with a reason, never stale
  data labeled fresh.
- `browserPick { sessionId, point }` hit-tests through the live page and
  returns a selection: locator ladder (test-id first, then role/name, then
  css; raw XPath and executable locator strings are not the contract),
  element role/name/text, a fingerprint for staleness detection, rect,
  viewport, and a clipped screenshot artifact ref. Attribute values, event
  handlers, secret-shaped fields, and outerHTML are excluded.
- `closeBrowserSession { sessionId }`.
- `listBrowserSessions {}` for the workspace.

WS events on the existing gateway socket (the `browser.frame` shape from
agentic-browsing.md, generalized):

- `browser.frame { sessionId, seq, jpegBase64, viewport }`: throttled
  screencast, emitted ONLY while at least one viewer is subscribed
  (subscribe/unsubscribe ride the existing stream plumbing). Reduced
  resolution by default; full viewport on request (maximized viewer).
- `browser.activity { sessionId, actionId, actor, revision, action, result }`:
  one settled semantic event, the journal's wire form.

Viewer route: the gateway serves `/browser/<sessionId>/viewer`, a stationary
page that paints `browser.frame` onto a canvas and forwards pointer/keyboard
input as `browserAct` calls, mounted the same way `/monitor` is
(MONITOR_UI_MOUNT_PATH pattern in apps/cli/src/index.js). Consumers embed it
through their own authenticated proxies; the viewer itself carries no
credentials and accepts host inputs via query parameters.

## Security

- `http:` and `https:` only. SSRF policy hook: deny loopback and private
  ranges and cloud metadata by default; the dev-server source kind is the
  single narrow exception, permitting exactly the declared loopback port.
- Typed text on password/OTP/payment/token fields never appears in journal,
  context, activity events, or logs (redacted length only).
- Downloads, uploads, popups, and new windows are blocked in v1.
- Every page-derived string in context/pick output is untrusted data; the
  consumer prompt contract (agentic-browsing.md) rests on the service never
  mixing page text into its own control metadata.

## Testing bar

Real-backend e2e, no route mocks (house rule): boot a real gateway with the
browser adapter, real headless Chromium, then prove: frames arrive only while
subscribed; act settles and increments revision exactly once per action;
duplicate actionId returns the prior outcome without side effects; stale
expectedRevision returns REVISION_CONFLICT; pick returns a stable locator on
a fixture page; context slices respect maxima; dev-server source reaches a
local fixture server while a private-range URL source is refused; idle TTL
reaps; quota rejects the N+1th session.

## Build order (v1)

1. `packages/server` browser adapter: Playwright session registry, revision
   and actionId ledger, journal, quotas, SSRF policy seam.
2. RPC methods and WS events per the checklist, client convenience methods.
3. Viewer route and minimal canvas viewer with input forwarding.
4. The e2e suite above.

Non-goals v1 (unchanged from agentic-browsing.md, plus): multiple tabs,
downloads/uploads, WebRTC, captcha, mobile viewports, credential broker or
persistent profiles, provider rental.
