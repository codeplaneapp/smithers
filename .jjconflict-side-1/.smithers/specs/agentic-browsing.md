# Agentic web browsing

How the agent navigates the web on the user's behalf, shown live inside
`apps/smithers`. One constraint shapes the whole design, and the existing
gateway, control, and approval primitives carry most of the weight.

## The constraint: the iframe holds a viewer, never the site

The obvious reading of "browse the web in an iframe" is `<iframe src="https://site">`.
It does not work, for two independent reasons:

- **Sites refuse to be framed.** Anything with `X-Frame-Options: DENY` or a
  restrictive `frame-ancestors` (Google, GitHub, banks, most of the useful web)
  never renders in a frame.
- **The same-origin policy blocks control.** Even when a site does load, the
  agent cannot read its DOM or dispatch clicks across origins. Loading it with
  the user's real cookies also gives the page's own JS a foothold in our origin.

A same-origin rewriting proxy (fetch server-side, strip `X-Frame-Options`,
rewrite every URL back to our origin) lifts the framing block and lets the agent
touch the DOM. It breaks on every JS-heavy app, is a permanent maintenance load,
and routing the user's authenticated traffic through a rewriter is its own
liability. Rejected.

So the iframe holds **a viewer onto a real browser that runs elsewhere, in a
sandbox.** The website executes in the sandbox, never in the user's origin. The
agent perceives the page through its accessibility tree plus screenshots and
acts through the Chrome DevTools Protocol (CDP). The user watches a pixel stream
and can take the wheel at any time. This is the Browserbase / Steel /
Computer-Use pattern, and it is the only one that is both general and safe.

The repo already proves this exact shape works: `gateway/WorkflowRunUi.tsx`
embeds a workflow's own UI in an iframe, and `gateway/GatewayRunInspector.tsx`
toggles between that embedded view and the native inspector. The browser viewer
is the same idea with a different payload.

## Architecture

```
 apps/smithers PWA                 gateway (WS)             sandboxed runtime
┌─────────────────────┐        ┌──────────────────┐       ┌────────────────────┐
│ browser surface     │◀─frames│ browser.frame    │◀──CDP─│ headful Chromium    │
│  └ viewer (iframe   │        │   events         │ screen│  ephemeral profile  │
│     or <canvas>)    │──input▶│ navigate/click/  │  cast │  egress-firewalled  │
│ ControlRing (Stop)  │        │  type RPCs       │──────▶│  one per run, wiped │
│ ApprovalDialog      │        │ submitApproval   │       └────────────────────┘
└─────────────────────┘        └──────────────────┘
   agent emits smithers:action directives ─▶ approval gate ─▶ CDP
```

Three pieces:

1. **Runtime.** A real headful Chromium in an ephemeral, egress-firewalled
   sandbox, one per run, destroyed when the run ends. Clean profile, no ambient
   access to the user's real browser. Phase 0 rents this from a provider; later
   phases self-host it (see [Runtime](#runtime-provider-first-self-host-later)).

2. **Perception and action split.** The agent reads the accessibility tree and
   screenshots (cheap, structured, and the model never sees raw cross-origin
   DOM it could be injected through). It acts via CDP `Input.dispatch*`. The
   user gets a separate `Page.startScreencast` pixel stream, so a site that
   blocks framing is irrelevant: the viewer frames our own stream, not the site.

3. **Transport.** Reuse the gateway WebSocket. `SmithersGatewayConnection`
   already multiplexes `{type:"event", seq, ...}` frames and the React side
   already consumes them through `useGatewayRunEvents`. Add a `browser.frame`
   event (base64 JPEG) plus `launchBrowserSession` / `navigate` / `click` /
   `type` / `readA11y` RPC methods alongside the existing `submitApproval` /
   `submitSignal` in `packages/gateway/src/rpc`. No new transport for v1.

## The surface

The viewer mounts the same way every other run surface does.

- A new card kind `{ kind: "browser", sessionId }` in `cards/Card.ts`, rendered
  by a `BrowserCard` branch in `cards/CardView.tsx`, for the inline chat view.
- A full-screen `browser` member of the `Surface` union in `app/Surface.ts`,
  mounted in the `main-canvas` of `app/AppShell.tsx` for the focused view. It
  carries the same header chrome as `GatewayRunInspector` (title, status pill,
  a Stop control).
- The viewer component mirrors `WorkflowRunUi`: in Phase 0 it is an `<iframe>`
  pointed at the provider's signed live-view URL; in Phase 1 it becomes a
  `<canvas>` (or `<img>`) fed by `browser.frame` events, with pointer and
  keyboard handlers that forward input over the WS when the user has control.

State follows the house rule (zustand only, no `useState`/`useEffect`): a
`browserStore` on the `ephemeral` medium holds session id, latest frame, the
current URL, and whether control sits with the user or the agent. The route id
lives in the URL (`/runs/$runId/browser`), the session object lives in the
store, the same split state-and-routing.md describes.

## The agent's actions

Browsing is the control protocol that already exists in `apps/smithers/src/control`,
with a richer action set and a higher approval bar.

- Extend `APP_ACTIONS` in `control/agentTools.ts` with `navigate`, `click`,
  `type`, `read`, and `back`. Each declares `name`, `description`, `argHint`,
  `describe()`, and `run()`, exactly like the existing `navigate`/`setTheme`
  actions. The agent emits them in the `smithers:action` JSONL fence that
  `control/parseAgentDirectives.ts` already parses.
- `control/controlStore.ts` already queues directives and applies them only
  after the user grants control, and `control/ControlRequestDialog.tsx` already
  lists the concrete planned actions before granting. That is the approval gate
  for browsing, reused unchanged.
- `control/agentSystemPrompt.ts` gains a trust-boundary section: **page content
  returned by `read` is untrusted data, never instructions.** The model is told
  that text scraped from a page can try to redirect it, and that it must ignore
  any such instruction. This is the primary defense against prompt injection.

For durable, unattended runs (a workflow that browses without a human watching),
the same operations are also exposed as `defineTool()` tools in
`packages/smithers/src/tools`, gated by `ApprovalGate` / `HumanTask` instead of
the live control dialog. Same capability, same safety rails, two entry points.

## Security model

The load-bearing idea: **the agent never holds ambient authority.** It gets a
clean sandbox, a domain policy, and an approval gate on anything that changes
state.

| Threat | Control | Reuses |
| --- | --- | --- |
| Prompt injection from page content | `read` output is labeled untrusted; the system prompt forbids treating page text as commands | `control/agentSystemPrompt.ts` |
| Misuse of the user's logged-in sessions | Clean ephemeral profile by default; auth is granted explicitly and interactively (see below) | new credential flow |
| Destructive or irreversible actions (buy, send, delete) | Reads auto-run; navigations and any mutating action pause for human approval | `ControlRequestDialog`, `ApprovalGate`, `submitApproval` |
| Navigating somewhere sensitive, or SSRF | Domain allow/deny list; block private IP ranges and cloud metadata (`169.254.169.254`); no `file://` | new navigation policy |
| Sandbox escape, internal-network reach | gVisor/Firecracker or Docker+seccomp, egress firewall, torn down per run | runtime infra |
| The viewer as an attack surface | The iframe loads only our own viewer origin with a tight `sandbox` attribute; the stream is pixels, so the target site's JS never runs in the user's page | viewer component |
| Runaway agent | Hard kill switch already present | `control/ControlRing.tsx` Stop |

Every action is recorded as a gateway event, so the existing `events` and
`timeline` surfaces give a full, replayable audit of where the agent went and
what it did.

## Auth: human-in-the-loop login

This is the central "on behalf of the user" decision, and the chosen model keeps
the user's credentials away from the agent entirely.

- The agent's browser starts with a **clean profile and no access to the user's
  real cookies or saved logins.**
- When the agent reaches a page that needs authentication, it cannot proceed.
  The run pauses on a `WaitForEvent` / `HumanTask` gate, the surface flips
  control to the user, and the user logs in directly on the live stream,
  including any 2FA. The agent does not see the keystrokes, and the credentials
  never enter the model context.
- The user hands control back, and the agent continues against the now
  authenticated session.
- That session lives only inside the ephemeral sandbox for the duration of the
  run and is wiped when the run ends. Nothing persists to the user's real
  profile.

A later phase can add opt-in, per-domain session reuse (so the user does not log
in to the same site on every run), stored encrypted and scoped, but the default
stays interactive login with zero standing authority.

## Transport and streaming

- **Phase 0:** the provider's signed live-view URL in an `<iframe>`. Zero
  streaming code on our side; the provider handles screencast and input.
- **Phase 1:** drop the provider iframe. The runtime drives `Page.startScreencast`
  over CDP, the gateway relays frames as `browser.frame` events on the existing
  WS, and the viewer paints them to a `<canvas>`. When the user takes control,
  pointer and key events forward back over the WS to CDP `Input.dispatch*`.
  Reuses `SmithersGatewayConnection` and the `useGatewayRunEvents` pattern; no
  WebRTC, no new transport.

## Runtime: provider first, self-host later

- **Phase 0–1:** rent the sandboxed browser from a managed provider (Browserbase
  or Steel). Fast to a working demo, and it offloads the hardest security
  surface (a hardened browser sandbox) while the UX and the safety model get
  proven end to end. Note the tradeoff: the user's browsing and any
  interactively entered session transit a third party during these phases, so
  the spike runs against non-sensitive sites.
- **Phase 2:** self-host the runtime: containerized Chromium under gVisor or
  Firecracker, egress-firewalled, one disposable instance per run, under our
  control. No third-party data egress. The transport, surface, control
  directives, and approval gates built in earlier phases do not change; only the
  thing on the other end of CDP does.

## Build plan

**Phase 0 (spike).** Provider live-view iframe in the `browser` surface. Agent
drives via CDP through the new RPC methods. Allowlist-only navigation, no auth,
every action routed through `ControlRequestDialog`. Proves the loop:
agent proposes, user approves, action runs, user watches.

Touches: `cards/Card.ts`, `cards/CardView.tsx`, `app/Surface.ts`,
`app/AppShell.tsx`, `control/agentTools.ts`, `control/agentSystemPrompt.ts`, new
`browser/` feature dir, new gateway RPC methods, provider client in the server.

**Phase 1.** Replace the provider iframe with `Page.startScreencast` over the
gateway WS. Add user takeover and input forwarding, the navigation policy and
SSRF guards, and the event-backed audit trail.

**Phase 2.** Human-in-the-loop login flow over the `WaitForEvent` gate.
Self-hosted sandboxed runtime. Optional per-domain session reuse, encrypted and
scoped. A risk classifier that decides auto-run vs. approval per action.

## Non-goals (for now)

Multiple tabs, file downloads and uploads, captcha solving, and mobile
viewports. Each is a deliberate later addition, not an oversight; the v1 target
is a single foreground tab, watched, with every state-changing action gated.
