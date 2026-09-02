# Smithers UI runtime contract

The same React application runs against two explicit hosts: jjhub Cloud and a
local Bun origin. Electrobun is an optional native shell around the local
origin; it is not a separate application or state model.

## Composition roots

| Host | Server | Native privileges | Typical capabilities |
| --- | --- | --- | --- |
| jjhub Cloud | `apps/server` Cloudflare Worker | none | agent, identity, jjhub, checkout when configured |
| Local browser/headless | `apps/ui/src/bun/serve.ts` | explicit development path entry | repositories, targets, terminal, harnesses; agent/identity only in hybrid mode |
| Local native | `apps/ui/src/bun/index.ts` + Electrobun | folder picker and system-browser handoff | same local services; no renderer-supplied filesystem paths |

The client first loads `GET /api/bootstrap` and validates it with
`AppBootstrapSchema`. Commands declare required runtime capabilities; the
registry omits unavailable commands. Components render from that registry,
so disabled hosts do not expose controls that can only fail.

Supported capabilities are `agent`, `identity`, `jjhub`, `billing.checkout`,
`keys.byok`, `local.repositories`, `local.repository-path-entry`,
`local.targets`, `local.terminal`, and `local.harnesses`.

## Local modes

`SMITHERS_LOCAL_MODE=offline` is the headless default and performs no Smithers
Cloud requests. `hybrid` enables the configured chat and identity upstreams.
`SMITHERS_CHAT_STUB=1` supplies a deterministic in-process agent for tests and
also disables the identity proxy.

The native launcher defaults to hybrid unless explicitly set to offline. The
packaged app serves its built SPA from `127.0.0.1` on a random port. The
headless server prints `SMITHERS_LOCAL_ORIGIN=http://127.0.0.1:<port>` when it
is ready.

## Local-origin security

Each server launch creates a fresh 256-bit token. The token is placed in the
served document's `smithers-local-session` meta tag. The client sends it in
the `x-smithers-local-session` header and in the WebSocket subprotocol.

The server rejects missing/invalid tokens, cross-origin API requests,
unexpected `Host`/`Origin` values, non-JSON mutation bodies, oversized HTTP
bodies and WebSocket frames, excessive subscriptions, and unknown client
message types. It binds loopback only.

The native RPC surface has exactly two privileged operations:

- `pickLocalRepository({ access })`, which returns a short-lived, one-shot
  authorization id for the selected directory;
- `openExternal({ url })`, which accepts only HTTP(S) URLs and opens the
  system browser.

Neither operation has an HTTP fallback in the packaged app.

The identity proxy re-scopes the seam's session cookie to the local origin
before the WebView sees it: `Domain` goes because the cookie belongs to this
origin now, and `Secure` goes because WebKit refuses a `Secure` cookie set over
`http://127.0.0.1` (Chromium accepts one, so only the native renderer showed
the failure). The trail line for `/api/auth/native/claim` names the cookie's
attributes, never its value, and every `/` and `/api/*` request leaves a
`METHOD /path -> status in Nms` line.

The cloud proxy (`/api/cloud/*`, lane piper) forwards to `SMITHERS_CLOUD_API`
(default `https://api.jjhub.tech`) with the same rules as the identity proxy:
Host and Origin follow the upstream, `content-length` and the local session
header are dropped, Set-Cookie is re-scoped, and the request carries
`Authorization: Bearer` from the Bun-side credential — the cloud token NEVER
reaches the renderer. Cloud sign-in (`/api/cloud-auth/*`) is the CLI's browser
flow: start answers the login URL, the callback lands on a loopback listener,
and the token lives in the macOS keychain (`smithers-cloud`) plus Bun memory;
the session route answers `{ state, username, expiresAt }` only.
`SMITHERS_CLOUD_TOKEN` is a dev/CI override read first. A signed-in session
loads the repository inventory (the sidebar's `org/ → repo → working copies`
tree) through the proxy; the bootstrap advertises the `jjhub` capability when
the proxy is enabled.

## Repository and process authority

Native repository opening is a two-step grant flow: the picker authorizes a
canonical path for 60 seconds, then `/api/repo/open` consumes the authorization
exactly once. Headless development explicitly advertises
`local.repository-path-entry` and may instead send `{ path }`.

Open repositories receive opaque `repoId` values and a read-only or read-write
access level. Process APIs accept `repoId`, never a renderer-controlled `cwd`.
Terminals and target execution require read-write access. Target queries mint
opaque target ids; a run resolves the command label server-side and rechecks
the current graph before spawning it.

PTY count, target-run count, input bytes, output buffering, and WebSocket
subscriptions are bounded. Shutdown awaits agent cancellation, process
termination, and server close.

## Multi-workspace repositories and plugins

Repository detection records the root and child Smithers workspaces (up to two
levels deep) as paths relative to the opened repository. Target discovery runs
the CLI once per detected workspace. Each opaque target grant binds its
workspace and label on the server; extra renderer-supplied fields cannot move a
process to another directory or change the command.

A repository may declare a strict version-1 plugin manifest at
`smithers-ui.json` in its root (never under `.smithers/`, which rc.0 treats as
0.x state; a manifest left there is reported as a repository warning). Groups and entries are schema-validated, every entry must
name a detected workspace and a Smithers target label, and invalid manifests
become visible repository warnings rather than partial UI. A valid manifest
renders a trusted `repo-plugin` React card. Its actions use the same target
snapshot and opaque-grant execution path as the ordinary targets card.

## HTTP and WebSocket surface

All mutations require `Content-Type: application/json`; failures use
`{ error: { code, message } }` locally.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/bootstrap` | Versioned host/capability contract |
| GET | `/api/health` | Local process, Node, and sandbox status |
| POST | `/api/agent/turn` | NDJSON agent stream (`/api/chat/turn` is a compatibility alias) |
| POST | `/api/agent/turn/cancel` | Cancel a turn (`/api/chat/cancel` is an alias) |
| GET | `/api/harnesses` | Installed harness snapshot |
| POST | `/api/repo/open` | Consume `{ authorizationId }`, or dev-only `{ path }` |
| GET | `/api/repos` | Open repository snapshot |
| POST | `/api/repo/close` | Close `{ repoId }` |
| POST | `/api/repo/files` | `{ repoId, path? }`: a directory's entries or one file's text (read access; bounded; binary stated) |
| POST | `/api/targets/query` | Query `{ repoId }` and mint target ids |
| POST | `/api/targets/run` | Run `{ repoId, targetId }` |
| POST | `/api/targets/cancel` | Cancel `{ runId }` |
| POST | `/api/targets/{graph,runs,runs/replay,affected,ci,open-source}` | Local target graph/history tools |
| GET/POST | `/api/pty` | List/create PTYs; create accepts `repoId`, never `cwd` |
| POST | `/api/pty/:id/resize` | Resize a PTY |
| DELETE | `/api/pty/:id` | Stop a PTY |
| ANY | `/api/cloud/*` | Cloud proxy to `SMITHERS_CLOUD_API` (Bearer from the Bun credential; 501 offline) |
| POST | `/api/cloud-auth/start` | Begin the browser login; answers `{ url }` |
| GET | `/api/cloud-auth/session` | `{ state, username, expiresAt }` — never the token |
| POST | `/api/cloud-auth/sign-out` | Delete the keychain credential and the in-memory token |
| POST | `/api/linear-auth/start` | Begin the Linear OAuth handoff (lane sync): a loopback listener on a random port waits for the cloud's redirect; answers `{ url }` to open. 501 offline |
| GET | `/api/linear-auth/session` | `{ state: "idle" \| "waiting" \| "authorized", setupKey? }` — the setup key once the callback lands, never the token |

WebSocket subscriptions carry target-run and PTY output. Client messages are
limited to subscription control, `target-run.attach`, and `pty.input`.

## Target presentation

Opening a repository renders nothing in the transcript; the sidebar pin and
the composer's selector name it. Target discovery is the explicit
`/target.list` act (the model has the same flow): it appends the trusted typed
React card, and a repository with no Smithers workspace answers the reason as
text.
Models can provide explanatory text but cannot author markup, scripts, command
labels, bridge messages, or action handlers. Historical HTML cards remain
decodable for migration and render in a CSP-restricted inert iframe with
scripts and network access denied.

## Cards

Every capability's output is an embedded card in the transcript (THE EMBED
LAW); maximizing one is a presentation transition of the same component. The
run lifecycle (lane `runs`, `docs/workbench-lanes/runs.md`) adds three
surfaces, all over the workspace gateway's own projections and procedures:

- **`run-list`** (`/runs.list [status] [flow] [by=] [lineage=] [owner/repo]`) —
  the workspace's runs from the `workspace-runs` projection, newest first, a
  mono count line by status in the header and filter chips that re-invoke
  `runs.list` with the chip's argument. A row's Open materializes the run's
  own card (`/runs.open <runId>`); the footer's `Stop all N` runs
  `/flow.run.stop-all` (a confirming flow). `by=` refuses honestly: the wire's
  run summary records no launcher.
- **`approvals-inbox`** (`/approvals.list [owner/repo]`) — every pending gate
  across the workspace's runs (the `approvals` projection with no run id).
  Each row carries the submit-ready envelope the gateway published, so its
  Approve/Deny dispatch the ordinary `approval.approve` / `approval.deny`
  flows addressed `inboxCardId:requestId` and the decision goes back
  unchanged. `/approvals.open <runId>` materializes one run's gates as
  ordinary approval cards.
- **`flow-run`** — the run card grows the lifecycle beyond launch: Stop on
  every non-terminal phase (`/flow.run.stop <cardId> [reason]`, confirming),
  Resume when the control plane names a wait other than an approval
  (`/runs.resume`), Run again when settled (`/runs.rerun` — the launch input
  recorded on the card at launch; an honest refusal when this client never
  saw it), and a steer row (`/runs.steer`, `/runs.seat`, `/runs.thinking`,
  `/runs.tools`) whose queued state reads `steering pending · delivered at
  the next turn`. A waiting run names the control plane's reason:
  `accepted · nothing is driving it` for an accepted run, the wait's word for
  a parked one. Three facet tabs switch the body: Steps (default),
  Transcript (`/runs.logs <runId> [--follow]` — follow merges the
  `transcript` projection on the pump's own cycle), and Events
  (`/runs.events <runId>` — the raw journal, rendered only where
  `/debug.verbose` is on).

Lane `citc` (ADR 0002) adds the persistent cloud computers:

- **`workspace`** (`/workspace.open [bookmark] [owner/repo]`, `/workspace.view
  <id>`) — one cloud computer bound to a repository bookmark. The header
  names the repo, the target bookmark, and the BOOKMARK's head (`bookmark
  main head @ qupxosqw`) — plue's workspace DTO carries no kind, no uptime,
  no workspace head, and no ahead/behind (plue#446), and the card carries
  none. A six-state pill (pending, starting, running, suspended, stopped,
  failed) leads; a starting workspace streams its `provisioningStage`, a
  failed one names the stage and offers Retry (`/workspace.open` again). The
  facet strip switches Terminal (the attached session, every session with
  its Destroy), Files and Services (empty with the ADR's wording — no routes
  exist, plue#449), and Snapshots (Fork from, Make template, Delete per
  row). The footer acts: Suspend or Resume, Fork, Snapshot, and Delete
  behind a typed confirm. `/workspace.terminal` opens the workspace's
  terminal as an ordinary terminal tab whose row carries a `workspaceId`
  instead of a `cwd` — the socket tunnels through the Bun server's
  `/api/cloud-ws/` bridge with the Bun-held bearer attached upstream (the
  token never reaches the renderer), and closing the tab detaches; killing
  the session is the explicit `/workspace.session.destroy`. Every workspace
  act refuses a `degraded` cloud session with the "sign in again to enable"
  wording (ADR 0001's legacy scope set).

Lane `change` (ADR 0003) makes the change the unit of review:

- **`change`** (`/change.view <changeId>`) — one card per change, rendered
  from plue's change DTO plus its auxiliaries: the per-repo stat, the
  carrying landing request's stack position (`Landing #42 · position 2 of 2
  · open → main`), and the changeset when the repository's owner is an org
  (a `failed` changeset renders its `failure_reason` verbatim and offers
  Retry land). Five facet tabs switch the body: Diff (the parent → current
  file rows, each opening its one-file diff), Checks (the newest answer per
  context), Review (verdicts and threads — no stale/moved tokens, plue#453),
  Findings and History (the ADR's degraded wording — no findings per
  revision, plue#454; no revision history, plue#450). The header names
  `repo · changeId · commit · author`, never `rev N of M`. The footer acts:
  Land (the carrying landing request — queued, never "merged"; the
  changeset's own atomic route when one carries the change, a 409 re-reads),
  Split ready and Resolve (honest refusals until plue#452/#455), Revert
  (only on a landed change; an honest refusal until plue#456). A `degraded`
  sign-in reads a change freely; dispatching the resolve agent refuses with
  the "sign in again to enable" wording.
- **`diff`** (`/change.diff <changeId> [from] [to] [path]`) — one from → to
  pair pinned at the change's commit (`pinned at a03f5f11`), conflicted
  files leading. A hunk inlines up to 400 patch lines; a larger one rides by
  reference and names its re-read (`/change.diff <changeId> parent current
  <path>`). Only change-vs-parent has a route today — a rev → rev interdiff
  refuses with the plue#451 wording.

Lane `sync` (ADR 0005) adds Linear and GitHub sync as actions:

- **`connector-setup`** (`/linear.connect [owner/repo]`, `/github.app
  [owner/repo]`) — one card kind serves both handoffs. The Linear half is
  the wizard: the steps authorize → team → repository → confirm render as
  rows that fill in (`authorized as Will`, `ENG · Engineering`), a failed
  step reads the server error verbatim (`authorization expired · Open
  Linear again`), and the OAuth handoff rides the Bun server's
  `/api/linear-auth/*` receiver — the setup key, never a token, reaches the
  renderer. On confirm the SAME card turns into the connected state:
  `ENG · Engineering → org/repo`, the last-sync age, and Sync now /
  Activity / Disconnect (`/linear.sync`, `/linear.activity`,
  `/linear.disconnect` — the last confirming). The GitHub half renders the
  App status read (`/github.app`) — installed `· installation <id> ·
  configured`, or the trusted install link with Open GitHub
  (`/github.app.open`) — plus Re-check and Reconcile
  (`/github.reconcile`; the route is 404 in prod today and its message
  shows verbatim). `/repos.app` stays as `github.app`'s hidden alias.
- **`sync-ops`** (`/linear.sync [integration]`, `/linear.activity
  [integration]`, `/github.mirror-sync [owner/repo]`) — one card kind
  serves Linear syncs and GitHub mirror syncs: the subject, the trigger's
  one fact (`sync started`, `already running`), and the durable ops, newest
  first, a failed row carrying the server's error verbatim with Retry
  (`/sync.retry <opId>`). The ops feed, the per-op retry, and the sync runs
  do not exist (plue#468/#470): the card renders the ADR's degraded note,
  `runState` stays null, and `/sync.retry` refuses with the wording — no
  `/ops` or run route is ever called.
- **`repo-import`** grows the job's own progress: the stage counts (`refs
  214 of 214 · objects … · issues …`) when the wire carries them, the
  failed phase's Retry through `/repos.import.retry <jobId>` (the route
  exists), and the done state's workspace link (`/workspace.view`). A
  structured 429 (`code: "github_rate_limited"`) renders the ADR's
  rate-limit line on every sync card — `GitHub rate limit reached · 0 of
  5,000 · resets 12:40 · Retry after` — as does a status answer whose
  remaining budget drops under a fifth; a plain 429 invents no reset.
- **`issue`** names the Linear link the DTO carries (`Linear ENG-482`,
  linked) or offers Link to Linear… (a composer prefill for
  `/issues.link-linear <n> `); the link act and its routes are plue#473, so
  the flow refuses with the wording and nothing is called.

The Connectors surface's rows read only what the app has read: GitHub's
count is the App statuses its own act filed, Linear's per-team state is the
integrations the seam loaded — a repository never checked is absent, never
assumed.

The composer's origin chip carries the probed checkout's pin: `~/smithers ·
qupxosqw · a03f5f` (`changeId#seq` only when the changes collection knows a
sequence — never from a commit comparison alone), beside piper's `N ahead of
main`. `rev N exists · view` renders only when BOTH seqs are known.

## Navigation and persistence

Durable routes use `/w/:workspace/b/:branch/f/:frame`. Browser back/forward,
reload, and immutable branch forks operate on workspace/branch/frame records in
the same store as cards. Fullscreen is explicit; the composer remains mounted
and usable while a card is maximized.

Repositories have one address space (lane piper, ADR 0001): the sidebar's
Repos section is the tree `org/ → repo → working copies` — cloud repositories
from the signed-in inventory, local checkouts nested under their repository
when the remote parses into it (standalone rows otherwise), cloud workspaces
beneath their repo. Selecting a repo row names `org/repo`; selecting a copy
row names `org/repo#copyId`. The composer's origin chip states where the
selection lives (`~/smithers · 3 ahead of main`, or `head @ qupxosqw` at a
repository's head). File cards carry the global address
(`/org/repo/path`) and the position the read was taken at; when the
repository's head commit has moved since, a "head moved" line offers an
explicit refresh — nothing re-reads on its own. `/files.list` and
`/files.read` accept a global path (`/files.read /org/repo/README.md`) when
the two-segment prefix is a repository the app knows.

## Build and verification

```sh
pnpm --filter smithers-ui typecheck
pnpm --filter smithers-ui test
pnpm --filter smithers-ui build:web
pnpm --filter smithers-ui test:e2e
bun run test:e2e
```

The web build is the Cloud Worker asset and the local server asset. Heavy graph
and markdown-editor modules are dynamic chunks, so they are absent from the
initial application chunk.

The root `test:e2e` command packages the stable macOS app with Electrobun's
native renderer, launches the actual bundle, and drives it through a loopback
bridge that exists only when `SMITHERS_E2E_BRIDGE=1` and requires a random
bearer token. The runner redirects application state to a temporary home,
keeps the local origin fixed across relaunch, fetches the pinned public
`codeplanesmithers/canary-sandbox` fixture into an isolated clone, and
preserves failure artifacts under `apps/ui/test-results/electrobun-packaged/`.
It covers the stable renderer, bridge security, native repository picker and
authorization, repository failure recovery, real target execution, chat and
repository persistence, card tabs, and a real PTY/WebSocket lifecycle.

The runner holds an atomic lease plus a per-test cleanup marker. If a prior
process died before cleanup, the next run removes its isolated state, writes a
stale-fixture report, and fails before launching a test. Rerun normally after
inspection; `SMITHERS_E2E_RECOVER_STALE=1 bun run test:e2e` explicitly repairs
and continues in a single invocation. The packaged lane is macOS-only and the
GitHub fixture scenario requires network access.
