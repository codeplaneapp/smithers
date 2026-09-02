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
