# jjhub Parity Plan: bringing the new smithers UI to the jjhub cloud platform

Authoritative, complete feature-parity plan. Target: the new smithers React PWA
(`apps/smithers`, chat-first) reaches parity with the jjhub cloud platform
(SolidJS app at `/Users/williamcory/plue/apps/ui` + Go backend at
`/Users/williamcory/plue/internal/routes`), while still serving the local
smithers gateway it already talks to. Every feature from the structured inventory
AND the completeness critic's priority fixes is folded in below with no gaps.

---

## 1. Executive summary

### Size and shape of the gap

jjhub is a full code-hosting + cloud-dev platform: 33 SolidJS screens over ~86 Go
routes spanning repos, source browsing, jj VCS (changes/operations/stacks/
protected-bookmarks/commit-status), landing requests (its PR), issues with full
metadata (labels/milestones/dependencies/artifacts/reactions/pins), workflows/
runs/triggers/caches/approvals, agent sessions, cloud workspaces + an in-browser
terminal, account/repo settings (ssh/deploy keys, PATs, oauth apps, webhooks,
secrets, variables, profile), notifications + search, and orgs/billing/
integrations/admin.

The new smithers UI implements almost none of jjhub's code-hosting surface as
*reachable* product. It is genuinely strong at exactly three things that are
backend-reachable today:

- **Gateway run inspection** — `gateway/gatewayStore.ts` over `/v1/rpc`
  (`listWorkflows`/`listRuns`/`getDevToolsSnapshot`/`getNodeOutput`/`launchRun`):
  a live run list, launch, a recursive node-tree inspector (`runs/RunTree.tsx`
  via `gateway/snapshotToRunNode.ts`) with lazy node output, and an embedded
  custom-UI iframe toggle (`gateway/WorkflowRunUi.tsx`). The node tree is *nicer*
  than jjhub's two flat node/step lists.
- **Chat** — `chat/chatStore.ts` streaming from a stateless Cerebras proxy worker
  (`worker.ts` `POST /api/chat`). The composer (`app/ComposerBar.tsx`) exceeds
  jjhub's with slash commands + dictation.
- **Login / session** — `auth/LoginPage.tsx` + `authStore.ts` + `authClient.ts`,
  proxied to the Plue Go API. Full parity.

### What is already realized on seed data (promote, do not rebuild)

Four feature areas are fully wired through the canonical `vcs/` template
(domain `.ts` + inline `Card` + focused `Canvas` + zustand `store` + `runRoute` +
`*Domain.test.ts`) — they are card+canvas+store+route+test, NOT bare `Surface`
stubs. They run on local zustand seed data with no network:

- `vcs/` — working-tree status / staging / commit / branches+bookmarks, with a
  real git/jj backend toggle (`VcsCanvas.tsx:48-63`). The toggle is *richer* than
  jjhub (jjhub is jj-only). Action verbs replay as chat lines + toasts
  (`vcsStore.ts:45-111`).
- `issues/` — list + open/closed/all filter + detail + create + close/reopen,
  labels/assignees read-only (`IssuesCanvas.tsx`, `issues.ts`).
- `landings/` — list + 5 filter tabs + create + detail + Info/Diff/Checks tabs +
  approve/request-changes/comment + Land (`LandingsCanvas.tsx`, `landings.ts`).
- `tickets/` — searchable markdown list + create/update/delete; *ahead* of
  jjhub's read-only `.smithers/tickets` viewer.

These keep their shells. Phase work swaps their seed store for a real data client
(gateway RPC or jjhub REST) and fills the missing sub-features the inventory lists
(comments, conflicts, reviews thread, per-change diff grouping, milestones, etc.).

### The whole classes it lacks

No repos/source, no repo dashboard, no jj operation log/stacks/protected-
bookmarks/commit-status, no cloud workspaces, no terminal, no wiki, no releases,
no notification inbox, no search, no settings surface at all (no `/settings`,
`/keys`, `/tokens`, `/webhooks`, `/profile`), no agent sessions/persistence/
hijack, no orgs/billing/integrations. The router exposes 13 paths; none are
settings or repo-scoped.

### The dual-backend mandate

One UI must serve **both** the local smithers gateway (run-context: a "workspace"
= a workflow run, reached via `/v1/rpc`) **and** cloud jjhub (repo-context:
owner/repo, reached via the jjhub Go REST API). These are two coexisting data
models, not one replacing the other. The plan treats this as a first-class
constraint: Phase 0 ships a **backend selector** and the route vocabulary for
both, and every code-hosting feature is built against a new `jjhub/` REST client
that lives beside (never replaces) `gateway/gatewayRpc.ts`.

### Honest MVP

Phases 0-7 (backend seam → workspaces/terminal → repos/source → jj VCS →
landings → issues-core → runs-parity/dispatch/approvals/agent-sessions) are the
daily loop. Everything after is breadth (settings, wiki/releases, notifications/
search, integrations, orgs/billing/admin). Admin and git transport are non-goals
(Section 5).

---

## 2. Architectural prerequisite (Phase 0): the backend seam

The new UI has **no jjhub Go-API client**. Today it reaches only:

- the smithers gateway: `POST {gatewayBase}/v1/rpc/<method>` via
  `gateway/gatewayRpc.ts` (5 methods), where `gatewayBase` comes from
  `authClient.getGatewayBaseUrl()` (localStorage + `VITE_SMITHERS_GATEWAY_BASE_URL`,
  `authClient.ts:255-289`);
- a Cloudflare worker (`worker.ts`) that proxies a fixed allowlist:
  `isAuthProxyRoute` = `/api/auth/*`, `/api/user`, `/api/user/*` →
  `AUTH_API_BASE_URL` (`worker.ts:185-187`); `isGatewayProxyRoute` = `/health`,
  `/v1/rpc*`, `/workflows*` → `GATEWAY_BASE_URL` (`worker.ts:189-191`); and
  `POST /api/chat` → Cerebras. The worker strips the `upgrade` header
  (`HOP_BY_HOP_HEADERS`), so no WebSocket passes through it.

Phase 0 ships the seam that gates every code-hosting + workspace feature. Nothing
in Phases 1+ is buildable without it.

**0a. jjhub REST client — `apps/smithers/src/jjhub/`**
New domain folder, colocated, one export per file:
- `jjhubFetch.ts` — `platformFetch(path, init)`: REST over `fetch` with
  `credentials: "include"` + `withAuthHeaders` (reuse from `authClient.ts:123`),
  Link-header `rel=next` cursor parsing, and `handleAuthRequired()` on 401.
  Mirrors jjhub's `apps/ui/src/lib/repoContext.ts` `apiFetch`.
- `platformBaseUrl.ts` — `getPlatformBaseUrl()`/`setPlatformBaseUrl()`/
  `platformUrl(path)` beside the gateway equivalents (`authClient.ts:273-289`),
  persisted to localStorage with `VITE_SMITHERS_PLATFORM_BASE_URL` default.
- `authenticatedEventSource.ts` — port of jjhub's `createAuthenticatedEventSource`:
  SSE with `Last-Event-ID` reconnect/replay. Required by live run logs, agent-
  session stream, notifications stream, workspace status. (jjhub:
  `Notifications.tsx:244-270`, `agent_session_stream.go:42-49`.)
- `websocketTicket.ts` — `issueWebSocketTicket()`: `POST /api/auth/sse-ticket` →
  `{ticket}` (jjhub `sse_ticket.go:32-50`, `Terminal.tsx:15-26`). Used by Terminal
  and any wss stream.
- `repoContext.ts` — zustand `useRepoContextStore`: `{ owner, repo }` selection
  driving every repo-scoped feature. The repo-context analog of the run-context
  the app already has.
- `jjhub.test.ts` — unit tests for cursor parsing, ticket issuance, base-url
  normalization.

**0b. Worker proxy extension — `worker.ts` + `env.ts`**
Add `isPlatformProxyRoute(pathname)` covering the code-hosting prefixes
(`/api/repos/*`, `/api/orgs/*`, `/api/search/*`, `/api/notifications/*`,
`/api/integrations/*`, `/api/oauth2/*`, `/resolve/*`) → a new `GO_API_BASE_URL`
(may equal `AUTH_API_BASE_URL` when jjhub is one Go monolith). Keep WebSocket
explicitly out of the worker (it strips `upgrade`); Terminal connects `wss://`
direct to `GO_API_BASE_URL` in deployed mode, or through a vite proxy in dev
(Risk R3). Extend `env.ts` with `GO_API_BASE_URL` + `PLATFORM_BASE_URL`.

**0c. Backend selector + dual route vocabulary**
- `app/backendStore.ts` — zustand `{ mode: "gateway" | "platform" }`. The shell
  shows a switch beside the existing `auth/RemoteModePanel.tsx`. In `gateway` mode
  the home view is the run/workflow grid (today's behavior); in `platform` mode
  the home view is the repo dashboard / "my workspaces".
- Owner/repo route space: extend `deriveRoute.ts` with `/:owner/:repo/...`
  patterns, matched **after** the existing `/runs/...` and `/gw/...` patterns so
  run surfaces still win (the regex order in `deriveRoute.ts:14-73` is
  load-bearing). Extend `Surface.ts` with new repo-scoped kinds incrementally per
  phase. Add a retained `RepoContext` search param the way `project` is retained
  (`navigation.ts:83-86`).

Effort: **L**. Backend deps: worker + `env.ts`; reuses `authClient` headers and
the existing auth proxy. No new npm deps for 0a-0c (ghostty/xterm comes in
Phase 1).

---

## 3. Complete gap table (every feature, grouped by domain)

Columns: **jjhub** (status in jjhub) · **new UI** (real status today) ·
**reach** (backend reachable from the new UI *today*) · **eff** (S/M/L/XL) ·
**pri** (P0..P3). "reach=yes" means a method exists on a backend the UI already
talks to; "no" means it needs Phase 0 + new backend wiring; "unknown" means it is
plausibly reachable via a gateway compute-node but unverified.

### Domain A — Repositories & source browsing

| Feature | jjhub | new UI | reach | eff | pri |
|---|---|---|---|---|---|
| Create repository (name/desc/private/auto-init/default bookmark) | full | none | no | XL | P1 |
| List a user's repositories (`/api/user/repos`) | full | none | no | L | P1 |
| Repo dashboard/overview (stat tiles, clone URL, ~25 sub-tab nav, recent activity) | full | none | no | XL | P1 |
| Browse source tree (dir listing at ref/path, breadcrumbs, parent) | full | none | no | L | P1 |
| View file contents (size/encoding, base64 decode) | full | none | no | M | P1 |
| Ref/branch selector for source | full | stub (seeded bookmarks) | no | M | P2 |
| Repo settings (full name, visibility, default bookmark, clone URLs) | full | none | no | M | P2 |
| Delete repository | full | none | no | S | P3 |
| Update repo (PATCH name/desc/visibility/topics/landing-queue) | full | none | no | M | P3 |
| Archive / unarchive | full | none | no | S | P3 |
| Fork repository | full | none | no | M | P3 |
| Transfer ownership | full | none | no | S | P3 |
| Repo topics (get/replace) | full | none | no | S | P3 |
| Stars / stargazers | full | none | no | M | P3 |
| Owner resolution (`/resolve/{name}`: user vs org) | full | none | no | S | P3 |
| Working-tree changes view (`/changes` analog) | full | partial (`vcs/`, seeded) | unknown | L | P0 |
| Repo sub-tab stubs (issues/tickets/landings) | full | realized (seed) | no | XL | P2 |

### Domain B — jj VCS (changes / operations / stacks / protected-bookmarks / commit-status)

| Feature | jjhub | new UI | reach | eff | pri |
|---|---|---|---|---|---|
| Change list (recent jj changes) w/ conflict/empty badges | full | partial (working-tree only) | yes | M | P1 |
| Change detail — Info tab (ids/author/parents) | full | none | unknown | M | P1 |
| Change diff — per-file +/-/rename/binary, whitespace toggle | full | partial (one raw patch blob) | yes | M | P1 |
| Change files list | full | none | unknown | S | P2 |
| Change conflicts view (per-file type + resolution) | full | none | no | M | P1 |
| File content at a change (`GetFileAtChange`) | full | none | no | M | P2 |
| Bookmarks list + ahead/behind | full | partial (seeded) | no | M | P1 |
| Create bookmark on a change | full | none | no | M | P2 |
| Delete bookmark | full | none | no | S | P2 |
| Operation log (jj undo history) + pagination | full | none | no | L | P2 |
| Working-tree status + stage/commit actions | n/a (jj model) | partial (seeded actions) | unknown | M | P0 |
| git/jj backend toggle | jj-only | full (richer) | yes | S | P2 |
| Stacked changes (active-stack get/upsert/delete) | full | partial (seeded landings) | no | L | P1 |
| Protected bookmarks (branch protection rules) | full | none | no | L | P3 |
| Commit statuses (CI status per ref/change) | full | stub (seeded "checks") | no | L | P2 |

### Domain C — Landing requests (PR review)

| Feature | jjhub | new UI | reach | eff | pri |
|---|---|---|---|---|---|
| List landing requests | full | full (seed) | no | M | P1 |
| State filter tabs (open/closed/merged) | full | full (seed, 5 filters) | no | S | P2 |
| Cursor pagination / load more | full | none | no | S | P3 |
| Create landing request (+ source bookmark, change_ids) | full | partial (title/desc/target) | no | M | P1 |
| Landing detail view (header/meta/body) | full | full (seed) | no | M | P1 |
| Detail tabs (Conversation / Files Changed / Conflicts) | full | partial (Info/Diff/Checks) | no | S | P2 |
| Diff viewer (per-change, per-file, unified) | full | partial (flat string) | no | M | P1 |
| Reviews list + submit (approve/request-changes/comment) | full | partial (no thread) | no | M | P1 |
| Dismiss review | full | none | no | S | P3 |
| Comments list + add (inline path/line) | full | none | no | M | P1 |
| Land action (enqueue, queue position + task id) | full | partial (instant flip) | no | M | P1 |
| Close / Reopen | full | none | no | S | P2 |
| Conflicts tab / conflict status | full | none | no | M | P2 |
| Status-checks tab (smithers-only invention) | n/a | stub (seed) | no | M | P3 |
| Stack / changes list (stack_size) | full | none | no | M | P2 |
| Navigation / routing into landings | full | full (`/landings`) | yes | S | P1 |

### Domain D — Issues + metadata

| Feature | jjhub | new UI | reach | eff | pri |
|---|---|---|---|---|---|
| Issue list with open/closed/all filter | full | full (seed) | no | S | P1 |
| Issue search/filter box | full | none (tickets has it) | no | S | P2 |
| Issue detail view | full | full (seed) | no | S | P1 |
| New issue form | full | full (seed) | no | S | P1 |
| Close / reopen issue | full | full (seed) | no | S | P1 |
| Issue comments (list + add + edit/delete) | full | none | no | M | P1 |
| Issue reactions (6-emoji toggle, also on comments) | full | none | no | M | P2 |
| Issue events timeline | full | none | no | M | P2 |
| Issue artifacts (presigned upload/download/delete) | full | none | no | L | P3 |
| Pin / unpin + pinned list | full (backend) | none | no | S | P3 |
| Issue dependencies (blocked-by) | full (backend) | none | no | M | P3 |
| Assignee/label/milestone editing on an issue | partial | partial (read-only display) | no | M | P1 |
| Labels CRUD console | full | none | no | M | P2 |
| Milestones CRUD console | full | none | no | M | P2 |
| Repository tickets (markdown work-items) | full (read-only) | full (seed, +CRUD) | no | S | P2 |
| Backend wiring for issues/labels/milestones API | full | none | no | XL | P1 |

### Domain E — Workflows / runs / triggers / caches / approvals

| Feature | jjhub | new UI | reach | eff | pri |
|---|---|---|---|---|---|
| Workflow definitions: list | full | partial (only ones with custom UI) | yes | M | P1 |
| Workflow definition detail (config/triggers/status/timestamps) | full | none | unknown | M | P2 |
| Dispatch a workflow (ref + typed/JSON inputs) | full | partial (empty input only) | yes | M | P1 |
| Workflow runs: list (all, status/trigger metadata) | full | partial (per-UI-workflow only) | yes | M | P1 |
| Run detail: status + trigger/run metadata | full | partial (status only) | yes | M | P1 |
| Run inspection: node tree / steps | full | full (richer tree) | yes | S | P0 |
| Per-node detail: logs + output | full | partial (output only, no logs) | yes | M | P1 |
| Run graph (mermaid) + plan XML | full | partial (custom-UI iframe) | yes | M | P3 |
| Live run logs (SSE, reconnect, replay) | full | stub (mock log) | no | L | **P1** |
| Cancel a running run | full | stub (mock flag) | no | M | **P1** |
| Rerun a run | full | none | no | M | P1 |
| Resume a paused/blocked run | full | stub (mock heartbeat) | no | M | P1 |
| Run artifacts: list/download/delete | full | none | no | L | P2 |
| Workflow triggers screen (schedule/event inventory) | full | stub (mock crons) | no | L | P2 |
| Schedules / cron triggers: create & manage | partial | stub (mock form) | no | M | P3 |
| Workflow caches: stats dashboard | full | none | no | L | P3 |
| Workflow caches: list/filter/detail/clear | full | none | no | L | P3 |
| Approvals: filtered list (pending/approved/rejected/all) | full | stub (single inline gate) | no | L | P1 |
| Approval detail: metadata + payload | full | partial (hardcoded summary) | no | M | P2 |
| Approve / Deny decision | full | stub (mock approve/deny) | no | M | **P1** |
| Run scores / eval scorecard (smithers-only) | n/a | stub (seed) | no | M | P3 |
| Time travel: scrubber/fork/replay/rewind (smithers-only) | n/a | stub (mock frames) | no | L | P2 |
| Custom per-workflow UI embedding (smithers-only) | n/a | full | yes | S | P2 |
| Run diff review (inline file changes) | partial | stub (mock diff) | no | M | P2 |

> **Critic priority fix applied.** Live run logs, Cancel, and Approve/Deny were
> marked P0 (core daily loop) in the draft but land in the runs-completion phase
> (Phase 7), not the foundational loop. They are now **P1** with an honest note:
> the *foundational* run loop (P0) is dispatch + list + node-tree inspect, all of
> which are `reach=yes` today. Live logs (SSE) and cancel/approve are
> important-but-secondary completion of the run feature, gated on new gateway RPCs
> that do not exist yet (`reach=no`). Per-node logs (P1) is the lower-level
> prerequisite for the live-logs stream and ships first within Phase 7.

### Domain F — Agent chat & sessions

| Feature | jjhub | new UI | reach | eff | pri |
|---|---|---|---|---|---|
| Agent chat conversation (send/reply/stream) | full | full | yes | S | P0 |
| Streaming transport (live server stream) | full (per-session SSE) | partial (single-POST SSE) | yes | S | P1 |
| Session persistence (survives reload) | full | none (in-memory) | no | L | P1 |
| Session list (browse prior sessions) | full | none | no | L | P2 |
| Create session | full | none | no | M | P2 |
| Delete session | full | none | no | M | P3 |
| Tool-call / tool-result message parts | full | stub (text-only) | no | L | P1 |
| Agent provider/transport selection (smithers/codex; workflow/http) | full | partial (static card) | no | M | P2 |
| Live run status surfaced in chat | full | partial (not joined) | yes | M | P2 |
| Hijack / handoff (backgrounded run streams into watched session) | full | none | no | XL | P1 |
| Empty-state affordance | full | full | yes | S | P3 |
| Composer UX (Enter/Shift-Enter/disable-while-sending) | full | full (richer) | yes | S | P0 |
| Error handling (failed send, offline, retry) | full | full | yes | S | P2 |

### Domain G — Cloud workspaces & terminal & snapshots

| Feature | jjhub | new UI | reach | eff | pri |
|---|---|---|---|---|---|
| List workspaces (per repo) | full | none | no | L | P1 |
| Create workspace | full | none | no | L | P1 |
| Delete workspace | full | none | no | S | P2 |
| Repo selector for workspace scope | full | none | no | M | P2 |
| Open in-browser terminal (ghostty-web) | full | none | no | XL | P1 |
| Terminal WebSocket-to-SSH PTY bridge | full | none | no | XL | P1 |
| Terminal connection status & lifecycle | full | none | no | M | P2 |
| Workspace sessions API (create/get/list/destroy + SSH info) | full | none | no | L | P2 |
| Workspace snapshots: list + dashboard stats | full | none | no | L | P2 |
| Create workspace snapshot from running workspace | full | none | no | M | P3 |
| Restore: create workspace from snapshot | full | none | no | M | P3 |
| Snapshot detail + delete + linked-workspace shortcut | full | none | no | M | P3 |
| Workspace lifecycle: suspend / resume / fork | full | none | no | M | P3 |
| Workspace status SSE stream | full | none | no | M | P3 |
| User workspaces across all repos (`/api/user/workspaces`) | full (backend) | none | no | M | P3 |
| Devtools snapshots (console/tool-state/file-tree/screenshot) | full (backend) | none | no | L | P3 |

### Domain H — Settings / auth (keys, tokens, oauth, webhooks, secrets, variables, profile, devices)

| Feature | jjhub | new UI | reach | eff | pri |
|---|---|---|---|---|---|
| Settings surface / navigation shell (`/settings`) | full | none | unknown | M | P2 |
| Login / OAuth sign-in (Google/GitHub/email/token) | full | full | yes | S | P0 |
| Logout / sign out | full | full | yes | S | P1 |
| Current-user identity display | full | full | yes | S | P1 |
| Profile edit (display name/avatar/bio) | full | none | yes | M | P3 |
| Email addresses (list/add/verify/delete/primary) | full | none | yes | M | P3 |
| Connected accounts (list/disconnect) | full | none | yes | S | P3 |
| Personal access tokens (list/create-with-scopes/delete/reveal) | full | none | yes | M | P2 |
| Active sessions (list/revoke) | full | none | yes | S | P3 |
| Account SSH keys (list/add/fingerprint/delete) | full | none | yes | M | P3 |
| Repo deploy keys (read-only/write toggle, delete) | full | none | no | L | P3 |
| OAuth applications (register/redirect URIs/scopes/secret/delete) | full | none | no | L | P3 |
| Repo webhooks CRUD (URL/secret/event matrix/active) | full | none | no | L | P3 |
| Webhook test delivery + delivery history | full | none | no | L | P3 |
| Repo & org secrets (list/set/delete) | full (backend) | none | no | L | P3 |
| Repo & org variables (list/get/set/delete) | full (backend) | none | no | L | P3 |
| Repo environment: variables tab (UI) | full | none | no | M | P2 |
| Repo environment: secrets tab (UI, values never returned) | full | none | no | M | P2 |
| Notification preferences | full (backend) | none | yes | M | P3 |
| Device registration (APNs push tokens) | full (backend) | none | yes | M | P3 |
| Gateway base URL / remote-mode config (smithers-only) | n/a | full | yes | S | P2 |
| SSE auth ticket issuance | full | none (Phase 0 adds it) | yes | M | P3 |

### Domain I — Notifications / inbox / search

| Feature | jjhub | new UI | reach | eff | pri |
|---|---|---|---|---|---|
| Persisted notification feed (list view) | full | none (ephemeral toasts) | no | XL | P1 |
| Inbox route (`/notifications`, `/inbox`) | full | none | no | M | P1 |
| Unread / All filter tabs + unread count | full | none | no | S | P2 |
| Mark single notification read | full | none | no | S | P1 |
| Mark all read | full | none | no | S | P2 |
| Notification preferences (issues/landings/mentions) | full | none | no | M | P3 |
| Live notification stream (SSE) + reconnect replay | full | none | no | L | P2 |
| Source-typed badges (approval/workflow/run/issue/landing) | full | none | no | S | P3 |
| Workflow/run progress toasts (ephemeral) | partial | full | yes | S | P1 |
| Unified search page (`/search`) with scope tabs | full | none | no | XL | P1 |
| Code search (path + snippet) | full | none | no | L | P2 |
| Issue search with state filter | full | none | no | L | P2 |
| Repository search | full | none | no | L | P3 |
| User search | full | none | no | M | P3 |
| Search pagination / result counts (cursor) | full | none | no | S | P3 |

### Domain J — Orgs / billing / integrations / admin / runners

| Feature | jjhub | new UI | reach | eff | pri |
|---|---|---|---|---|---|
| Personal access tokens (list/create/delete) | full | none | yes | M | P2 |
| Active sessions (list/revoke) | full | none | yes | S | P2 |
| Organization profile (get/create/update) | backend-only | none | no | L | P3 |
| Organization members (list/add-role/remove) | backend-only | none | no | L | P3 |
| Teams (list/create/get/update/delete) | backend-only | none | no | L | P3 |
| Team membership & team repos | backend-only | none | no | L | P3 |
| Billing overview & checkout (user+org) + Stripe portal | backend-only | none | no | XL | P3 |
| Repo watch subscriptions (list/get/set-mode/unwatch) | backend-only | none | no | M | P3 |
| Integrations catalog (MCP + sync + skills) | full (backend) | partial (workflow store) | no | M | P2 |
| Linear integration (OAuth, configure, sync, webhook) | full | none | no | XL | P3 |
| GitHub sandbox proxy + Mirror webhook | backend-only | none | no | L | non-goal |
| Alpha access: waitlist join + admin whitelist/approve | full (backend) | none | no | M | P3 |
| Feature flags (public flag map) | full (backend) | none | no | S | non-goal |
| Client error telemetry sink | full (backend) | none | no | S | non-goal |
| Admin: users / orgs / repos / runners / health / audit | full (CLI `smithersctl`) | none | no | — | non-goal |

---

## 4. Phased roadmap

Ordered by the real daily loop. Each phase: goal, features landed, concrete new
files (respecting colocate-by-domain, one-export-per-file, filename==export,
zustand-only, zero `useState`/`useEffect`, the `vcs/` card→canvas→store→route→test
template). The seam edit points are always the same five files: `app/Surface.ts`,
`app/deriveRoute.ts`, `app/navigation.ts` (`openSurface` switch),
`app/runSlash.ts`, `cards/CardView.tsx`.

### Phase 0 — Backend seam (gate for everything)
Goal: make jjhub reachable and let one UI serve both backends.
Files: `jjhub/jjhubFetch.ts`, `jjhub/platformBaseUrl.ts`,
`jjhub/authenticatedEventSource.ts`, `jjhub/websocketTicket.ts`,
`jjhub/repoContext.ts`, `jjhub/jjhub.test.ts`, `app/backendStore.ts`; edits to
`worker.ts` (`isPlatformProxyRoute` + `GO_API_BASE_URL`), `env.ts`,
`deriveRoute.ts` (owner/repo patterns). Backend dep: worker proxy.
Grammar: a backend-selector control in the shell beside `RemoteModePanel`.
Effort: **L**.

### Phase 1 — Cloud workspaces + terminal (the root home, primary compute unit)
Goal: the workspace is jjhub's home and primary unit of work; do not bury it. List
/ create / delete workspaces and attach an in-browser PTY.
Features: list workspaces, create, delete, repo selector, open terminal
(ghostty-web), WS-to-SSH PTY bridge, connection status/lifecycle, workspace
sessions.
Files: `workspaces/workspaces.ts` (domain), `workspaces/WorkspacesCanvas.tsx`,
`workspaces/WorkspacesCard.tsx`, `workspaces/workspacesStore.ts`,
`workspaces/runWorkspacesRoute.tsx`, `workspaces/workspacesDomain.test.ts`;
`terminal/TerminalCanvas.tsx` (ghostty mount; **breaks the card grammar** — it is
a full-canvas xterm/PTY surface, never an inline card), `terminal/terminalStore.ts`
(WS lifecycle, ticket, resize), `terminal/runTerminalRoute.tsx`
(`/t/:owner/:repo/:wsId`). Seam: add `{kind:"workspaces"}` and
`{kind:"terminal";owner;repo;wsId}` to `Surface.ts`; route patterns in
`deriveRoute.ts`; `openSurface` cases. Backend dep: `workspace.go`
(`CreateWorkspace`/`ListWorkspaces`/`DeleteWorkspace`/`CreateSession`/
`DestroySession`/`GetSSHConnectionInfo`), `workspace_terminal.go`
(`TerminalWebSocket`), `sse_ticket.go` (ticket via Phase 0 `websocketTicket.ts`).
New dep: `ghostty-web`. Effort: **XL** (Terminal WS+SSH+ticket is the single
hardest piece; Risk R3/R4). Defer suspend/resume/fork + snapshots to Phase 12.

### Phase 2 — Repositories + source browsing
Goal: the repo dashboard hub and source reader; repo-context selection drives
everything downstream.
Features: list user repos, repo dashboard/overview (stat tiles, clone URL, sub-tab
nav, recent activity), browse source tree, view file contents, ref selector,
create repo.
Files: `repos/repos.ts`, `repos/ReposCard.tsx` (repo picker inline card),
`repos/RepoDashboardCanvas.tsx`, `repos/SourceBrowserCanvas.tsx`,
`repos/reposStore.ts`, `repos/runRepoRoute.tsx`
(`/:owner/:repo`, `/:owner/:repo/tree/:ref/*`), `repos/reposDomain.test.ts`,
`repos/NewRepositoryCard.tsx`. Seam: `{kind:"repo";owner;repo;tab}`,
`{kind:"source";owner;repo;ref;path}`. Backend dep: `user_repos.go`
(`ListUserRepos`), `repos.go` (`GetRepo`/`CreateRepo`/`GetRepoContents`/
`ListGitRefs`), `resolve.go` (`GetResolve`). Grammar: dashboard + source are
focused canvases; repo picker is an inline card. Effort: **XL**.

### Phase 3 — jj VCS (changes / operations / stacks)
Goal: promote the realized `vcs/` shell to a live jj surface; add the historical
change log, operation log, and stacks.
Features: change list w/ conflict/empty badges, change detail (Info/Diff/Files/
Conflicts), per-file diff (+/-/rename/binary, whitespace toggle), file-at-change,
bookmarks list + create/delete, operation log + pagination, stacked changes
(active-stack), commit statuses (read). Promote the existing `vcs/` working-tree
dashboard; wire its store to the gateway vcs workflow (compute-node `git`/`jj`
status/log/diff — Risk R2) and to jjhub `jj_vcs.go` in platform mode.
Files: extend `vcs/` with `vcs/ChangeListCanvas.tsx`, `vcs/ChangeDetailCanvas.tsx`,
`vcs/changes.ts`, `vcs/conflicts.ts`, `vcs/operations.ts`,
`vcs/OperationsCanvas.tsx`; reuse the richer `diff/DiffCanvas.tsx` for change
diffs (it exists, currently unused by vcs). Swap `vcsStore.ts` seed for a client.
Backend dep: `jj_vcs.go` (`ListChanges`/`GetChange`/`GetChangeDiff`/
`GetChangeFiles`/`GetChangeConflicts`/`GetFileAtChange`/`ListBookmarks`/
`CreateBookmark`/`DeleteBookmark`/`ListOperations`), `stacks.go`,
`commit_status.go`; OR a new gateway vcs RPC for the run-context case. Grammar:
change list + detail are canvases; the `VcsCard` stays an inline summary card.
Effort: **L**.

### Phase 4 — Landing requests (PR review)
Goal: promote the realized `landings/` shell to a real PR surface.
Features: fill create form (source bookmark + change_ids), Conversation tab with
reviews thread + comments (inline path/line), Conflicts tab + conflict gating,
per-change/per-file diff grouping (reuse `diff/`), Land with real queue position +
task id, Close/Reopen, dismiss review, stack/changes list, cursor pagination,
per-landing deep-link route (`/:owner/:repo/landings/:number`).
Files: extend `landings/`: `landings/LandingDetailCanvas.tsx`,
`landings/reviews.ts`, `landings/comments.ts`, `landings/conflicts.ts`; swap
`landingsStore.ts` seed for `platformFetch`. Backend dep: `landings.go`
(`ListLandings`/`CreateLanding`/`GetLanding`/`PatchLanding`/`EnqueueLanding`/
`PostReview`/`DismissReview`/`PostComment`/`ListLandingChanges`/diff/conflicts).
Grammar: list card + detail canvas. Effort: **L**.

### Phase 5 — Issues core (+ tickets promote)
Goal: promote `issues/` + `tickets/`; add comments, the missing daily-loop pieces.
Features: live issue list/detail/create/close/reopen (swap seed for API),
comments (list/add/edit/delete), assignee/label/milestone display + edit on an
issue, issue search box. Promote `tickets/` to read real `.smithers/tickets` via
repo contents.
Files: extend `issues/`: `issues/comments.ts`, `issues/IssueDetailCanvas.tsx`
(comments thread), edit `issuesStore.ts` to `platformFetch`. Backend dep:
`issues.go` (`ListIssues`/`GetIssue`/`CreateIssue`/`PatchIssue`/`PostIssueComment`/
`ListIssueComments`/`PatchIssueComment`/`DeleteIssueComment`), `labels.go`
(`GetIssueLabels`/`PostIssueLabels`/`DeleteIssueLabel`), `repos.go` contents for
tickets. Grammar: list card + detail canvas. Effort: **L**.

### Phase 6 — Issue metadata (labels / milestones / reactions / events / deps / pins / artifacts)
Goal: the issue-tracker admin + activity surfaces, split from issues-core.
Features: Labels CRUD console, Milestones CRUD console, reactions (6-emoji on
issues + comments), events timeline, dependencies (blocked-by), pin/unpin +
pinned list, artifacts (presigned upload/download/delete).
Files: `issues/labels/LabelsCanvas.tsx` + `labels.ts` + `labelsStore.ts`,
`issues/milestones/MilestonesCanvas.tsx` + `milestones.ts` + store,
`issues/reactions.ts`, `issues/events.ts`, `issues/dependencies.ts`,
`issues/artifacts.ts`. Backend dep: `labels.go`, `milestones.go`,
`issue_reactions.go`, `issue_events.go`, `issue_dependencies.go`,
`issue_pins.go`, `issue_artifacts.go` (presigned object storage). Grammar:
labels/milestones are canvases; reactions/events/deps render inline in the issue
detail canvas. Effort: **L** (artifacts adds an object-storage XL slice; defer
to P3).

### Phase 7 — Runs parity + dispatch + approvals-list + durable agent sessions
Goal: complete the run feature against the gateway; add durable agent sessions.
Per the critic, this is completion over the foundational loop, but it carries the
P1 run actions.
Features (gateway-reachable now): workflow definitions list (stop filtering to
custom-UI-only — `gatewayStore.ts:54-71` discards non-UI workflows today),
dispatch with ref + typed/JSON inputs (extend `launchRun`, which sends `{input:{}}`
at `gatewayStore.ts:267-279`), all-runs list + status filter, run-detail metadata
grid, **per-node logs** (the prerequisite), **live run logs (SSE)**, **cancel**,
rerun, resume, run artifacts. Approvals: filtered list (pending/approved/rejected/
all), approval detail + payload, **approve/deny** (promote the inline
`ApprovalCard`). Agent sessions: persistence, session list, create/delete,
tool-call/tool-result parts, provider/transport selection, live run status joined
to chat, hijack/handoff.
Files: `runs/dispatch/DispatchCard.tsx` + `dispatch.ts` (input schema form),
`runs/RunsListCanvas.tsx` (all-runs), `runs/runLogsStream.ts` (SSE via Phase 0
`authenticatedEventSource`), edits to `gateway/gatewayStore.ts` (cancel/rerun/
resume RPCs), `approvals/ApprovalsCanvas.tsx` + `approvals/approvals.ts` +
`approvals/approvalsStore.ts`, `sessions/sessions.ts` + `sessions/SessionsCanvas.tsx`
+ `sessions/sessionsStore.ts` + `sessions/sessionStream.ts`,
`chat/messageParts.ts` (tool_call/tool_result). Backend dep — **new gateway RPCs
required** for cancel/rerun/resume/log-stream/approve-deny (smithers
`cancel`/`replay`/`resume`/`approve`/`deny`/`events` exist as CLI but are NOT
wired into gateway RPC today, so `reach=no`); jjhub analogs are `workflows.go`
(`CancelWorkflowRun`/`RerunWorkflowRun`), `workflow_inspection.go`
(`ResumeWorkflowRun`/`GetWorkflowRunNode`/`DispatchWorkflowByIdentifier`),
`workflow_runs.go` (SSE log stream), `approvals.go` (`ListApprovals`/`Decide`),
`agent_sessions.go` + `agent_session_stream.go` + `agent_internal.go` (hijack).
Grammar: dispatch + approval inline cards; runs/approvals/sessions lists are
canvases; live logs is a canvas; toasts for run-status. Effort: **L** (hijack
alone is XL — Risk R6).

### Phase 8 — Repo env (vars/secrets) + deploy keys + webhooks + repo prompts
Goal: CI config + repo plumbing settings.
Features: RepoEnvironment variables tab + secrets tab, deploy keys (read-only/
write), webhooks CRUD + event matrix + test delivery + delivery history, repo
prompts (read `.smithers/prompts/*` via contents, props detection).
Files: `repos/environment/EnvironmentCanvas.tsx` + `variables.ts` + `secrets.ts`,
`repos/keys/DeployKeysCanvas.tsx`, `repos/webhooks/WebhooksCanvas.tsx` +
`webhooks.ts` + `deliveries.ts`, `repos/prompts/RepoPromptsCanvas.tsx` (distinct
from the existing composer `prompts/` template picker). Backend dep:
`variables.go`, `secrets.go`, `deploy_keys.go`, `webhooks.go`, `repos.go`
contents. Grammar: all canvases under the repo dashboard. Effort: **L**.

### Phase 9 — Account settings + auth shell
Goal: the `/settings` shell and account-scoped pages (most are `reach=yes` today).
Features: settings nav shell, PATs (list/create-with-scopes/delete/reveal),
active sessions (list/revoke), profile edit, emails, connected accounts, SSH
keys, OAuth apps, notification preferences, device registration.
Files: `settings/SettingsShell.tsx`, `settings/tokens/TokensCanvas.tsx` +
`tokens.ts`, `settings/sessions/SessionsCanvas.tsx`, `settings/profile/...`,
`settings/sshKeys/...`, `settings/oauthApps/...`. Seam: `{kind:"settings";tab}`.
Backend dep: `user.go` (`GetUserTokens`/`PostUserToken`/`DeleteUserToken`/
`GetUserSessions`/`DeleteUserSession`/`PatchAuthenticatedUser`/emails/connections/
notification-prefs/devices — all under `/api/user/*`, already proxied),
`ssh_keys.go`, `oauth2.go` (needs `/api/oauth2/*` added to the Phase 0 allowlist).
Grammar: settings shell is a canvas with tab sub-canvases. PATs are highest value
(the gateway uses bearer tokens, `gatewayRpc.ts` `withAuthHeaders`). Effort: **L**.

### Phase 10 — Repo settings + lifecycle
Goal: repo metadata + danger-zone.
Features: repo settings (full name/visibility/default bookmark/clone URLs), update
(PATCH), delete, archive/unarchive, fork, transfer, topics, stars/stargazers,
connect/disconnect + GitHub-app status, sync.
Files: `repos/settings/RepoSettingsCanvas.tsx` + `repoSettings.ts`. Backend dep:
`repos.go` (`PatchRepo`/`DeleteRepo`/`ArchiveRepo`/`ForkRepo`/`TransferRepo`/
topics/stargazers), `repo_connection.go`, `repo_sync.go`. Grammar: canvas under
the repo dashboard. Effort: **M**.

### Phase 11 — Wiki + releases
Goal: the two remaining repo-scoped content features.
Features: wiki (list/search/view/create/edit/delete/revisions), releases (list +
filters + summary counts, detail, create/edit/delete, assets view).
Files: `wiki/WikiCanvas.tsx` + `wiki.ts` + `wikiStore.ts` + `runWikiRoute.tsx`,
`releases/ReleasesCanvas.tsx` + `releases.ts` + store + route. Backend dep:
`wiki.go`, `release.go` (read-side only; asset write-side is a non-goal).
Grammar: canvases. Effort: **L** (both are large screens; credibility note R8).

### Phase 12 — Workspace snapshots + lifecycle
Goal: complete the workspace product.
Features: workspace snapshots list + stats, create from running workspace, restore
to new workspace, snapshot detail/delete/linked-terminal, suspend/resume/fork,
status SSE stream, user-workspaces-across-repos, devtools snapshots.
Files: extend `workspaces/`: `workspaces/snapshots/SnapshotsCanvas.tsx` +
`snapshots.ts` + store; `workspaces/lifecycle.ts`; `workspaces/statusStream.ts`.
Backend dep: `workspace.go` snapshot + lifecycle + stream handlers,
`devtools_snapshots.go`. Effort: **L**.

### Phase 13 — Notifications inbox + search
Goal: the cross-cutting feed and finder.
Features: persisted notification feed, inbox route, unread/all + counts, mark
read / mark all, preferences, live SSE stream, source-typed badges; unified
search with 4 scope tabs (code/issues/repos/users), filters, pagination. Keep the
existing ephemeral toast stack (`notifications/Toasts.tsx`) as the live slice.
Files: `inbox/InboxCanvas.tsx` + `inbox.ts` + `inboxStore.ts` + `inboxStream.ts` +
route, `search/SearchCanvas.tsx` + `search.ts` + `searchStore.ts` + route. Seam:
`{kind:"inbox"}`, `{kind:"search";scope;q}`. Backend dep: `notification.go`,
`search.go`. Grammar: canvases; toasts stay for live push. Effort: **L**.

### Phase 14 — Integrations (Linear / GitHub) + orgs/billing last
Goal: the long tail. Mostly P3.
Features: integrations catalog (reuse the `store/` install/installed pattern),
Linear OAuth + configure + sync, repo connection + GitHub-app status, orgs/teams,
billing (thin "open Stripe portal"), repo watch subscriptions, alpha waitlist join.
Files: `integrations/IntegrationsCanvas.tsx` + `integrations.ts`,
`integrations/linear/...`, `orgs/...`, `billing/BillingCard.tsx`. Backend dep:
`integrations.go`, `linear_integration.go`, `repo_connection.go`, `orgs.go`,
`billing.go`, `subscription.go`, `alpha_access.go`. Effort: **XL** spread over the
tail. Admin dashboards stay in `apps/admin` (non-goal).

---

## 5. Explicit non-goals / admin-only

- **Git Smart HTTP transport** (`git_smart_http.go`: info/refs, upload-pack,
  receive-pack) and **Git LFS** (`lfs.go`). These belong on the Go backend, not a
  Cloudflare worker. The PWA may *display* the clone URL (cheap, Phase 2); it
  never *serves* git. Cloning/pushing happens against `GO_API_BASE_URL` directly
  with a git client, outside the PWA.
- **The entire `admin_*` family** (`admin_users`/`admin_orgs`/`admin_repos`/
  `admin_runners`/`admin_system_health`/`admin_audit`) and **runner pools**. Dense
  ops dashboards. Already served by the `smithersctl` CLI (`apps/admin`). Out of
  scope for the user-facing UI.
- **Server-to-server plumbing**: `github_proxy.go`, `github_webhook.go`,
  `git_mirror_sync.go`, `workspace_internal.go`, `agent_internal.go` ingress side,
  Stripe webhook, Linear webhook receiver, `push_hook.go`. No UI even in jjhub.
- **Release asset write-side**: `PostReleaseAsset`/`Confirm`/`Patch`/`Delete`/
  download-URL + the SSE release stream. Phase 11 ships read-only assets; jjhub's
  own UI is read-only too.
- **Feature flags** (`flags.go`) and **client telemetry** (`telemetry.go`). Infra,
  not screens. The PWA gates by its own router/store.
- **APNs device push** beyond storing a token: native concern, low relevance to a
  PWA. The `user_devices.go` register endpoint is proxied but unused.
- **Full multi-tenant auth model**: orgs/teams/billing land last (Phase 14) and
  thin. The PWA stays single-user-session-first; the org RBAC machinery is a
  backend concern surfaced minimally.

### Reverse gap — preserve smithers capabilities jjhub lacks

These have no jjhub equivalent and must survive the port: the custom-UI iframe
embed (`gateway/WorkflowRunUi.tsx`), the recursive node tree
(`gateway/snapshotToRunNode.ts`), time-travel (fork/replay/rewind/scrubber,
`timeline/`), prompt-fill into the composer (`prompts/`), the git/jj backend
toggle (`vcs/`), and run scores (`scores/`). Phases 3/7 wire these to real
gateway data rather than dropping them.

---

## 6. Risks & open questions

- **R1 — Dual-backend coherence.** One UI, two data models (run-context via
  gateway RPC, repo-context via jjhub REST). `app/backendStore.ts` picks the home
  view; route patterns coexist (`/runs/...` and `/gw/...` matched before
  `/:owner/:repo/...`). Decision: imply the backend by path shape (run paths →
  gateway, owner/repo paths → platform), with the selector only switching the
  *home* view. This avoids a global mode flag leaking into deep links.
- **R2 — vcs reachability via gateway compute-node.** The realized `vcs/` could be
  made real in run-context by a gateway workflow that shells out (`git`/`jj`
  status/log/diff via a compute node — see `reference_smithers_compute_nodes`).
  This is `reach=unknown`: read verbs (status/log/diff) work; commit/push are
  plan-only today (`vcsStore.ts` posts a chat line, never executes). Needs a
  verified vcs gateway RPC or it stays platform-only (jjhub `jj_vcs.go`).
- **R3 — SSE / WebSocket on Cloudflare Workers.** The worker strips the `upgrade`
  header and has no 101 path. SSE (notifications, agent stream, run logs) works
  through the worker as a streamed response, but the Terminal PTY WebSocket cannot.
  Terminal must connect `wss://` straight to `GO_API_BASE_URL` (origin check on the
  Go side, `workspace_terminal.go`) in deployed mode, or via a vite WS proxy in
  dev. This is a hard architectural fork, not a config tweak.
- **R4 — WebSocket-ticket auth for Terminal.** The PTY uses a one-time ticket
  (`POST /api/auth/sse-ticket` → `?ticket=` on the wss URL, `Terminal.tsx:188-208`)
  because browsers can't set WS auth headers. Phase 0 ships `websocketTicket.ts`;
  the Go origin check + pinned-host-key SSH dial (`workspace_terminal.go:389-527`)
  are pre-existing backend, not new work.
- **R5 — Typed message parts need a producing backend.** Tool-call/tool-result
  rendering (Phase 7) is inert without a runner that emits those parts. The Cerebras
  chat proxy emits plain text; only a real coding-agent run (`agent_sessions.go`
  `DispatchAgentRun` + `agent_internal.go PostSessionEvent`) produces tool parts.
  So the data model + ingest path are both new.
- **R6 — Hijack/handoff lives in CLI, not gateway RPC.** `smithers hijack`/`chat`/
  `chat-create` exist as CLI skills; there is no gateway RPC to attach a
  backgrounded run's events into a watched session. This is the biggest single gap
  in the agent-session domain (XL) and requires a new gateway endpoint or the jjhub
  `agent_internal.go` token-scoped callback path. Until then, hijack is the one
  durable-agent feature with no reachable backend.
- **R7 — Owner/repo routing churn.** The new app has no owner/repo URL space.
  Introducing `/:owner/:repo/...` (Phase 0/2) touches `deriveRoute.ts`,
  `navigation.ts`, `Surface.ts`, and every repo-scoped phase. The patterns must be
  matched after the existing `/runs/` and `/gw/` patterns (regex order in
  `deriveRoute.ts:14-73` is load-bearing) or run surfaces break.
- **R8 — Effort credibility for wiki/releases/workspaces.** Wiki (Wiki.tsx ~26KB),
  Releases (~37KB), and Workspaces+Terminal+Snapshots (~62KB combined) are large
  jjhub screens. Their **L/XL** ratings assume the Phase 0 client + the `vcs/`
  template absorb the boilerplate (fetch, cursor, store wiring). The terminal's
  PTY/SSH transport (R3/R4) is the one place effort could blow past XL; treat
  Phase 1 as the schedule risk.
