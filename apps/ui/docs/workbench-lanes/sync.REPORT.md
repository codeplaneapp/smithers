# Lane `sync` — REPORT

Brief: `sync.md`. ADR: `../decisions/0005-linear-github-sync.md`. Status: all
steps shipped and green; the lane's gates pass, and the only failures in the
tree are the three pre-existing TargetGraph integration tests (the
`~/artsy/force` fixture). Playwright T1: 3 pass.

## What shipped, per step

1. **Shared schemas** (`apps/shared/src/Cards.ts`, `LocalApp.ts`): the
   `connector-setup` card payload (connector linear|github, repo, phase
   setup|connected, steps[] with verbatim per-step errors, setupKey /
   setupExpiresAt / actor / teams / teamId for the Linear wizard,
   integration for the connected state, installationId / configured /
   installUrl for GitHub, rateLimit, error), the `sync-ops` card payload
   (subject, source linear|github-mirror, runState null until plue#468/#470,
   counts, trigger, ops[] with verbatim errors and retryable, opsNote,
   window, expanded, hasOlder, rateLimit, error), `GitHubRateLimitSchema`,
   the `repo-import` payload's progress fields (stage, counts, error,
   repository, workspaceId, rateLimit), the `issue` payload's optional
   `linear { identifier, url }`, and the `/api/linear-auth/*` route
   constants and session/start schemas. No schema bump — additive only.
2. **Model + seams.** Two additive collections (`app-linear-integrations`,
   `app-github-app-statuses` — the Connectors rows read only these DTO
   reads, never assumptions) with `linear.integrations.loaded` (scope
   replace) and `github.app-status.loaded` (upsert) transitions.
   `bun/LinearAuth.ts` is the OAuth receiver: a loopback listener on a
   random port (bypassing the main server's session-header auth, mirroring
   `CloudAuth.ts`), 5-minute timeout, one-claim 409. The settled handoff:
   plue's fixed OAuth `redirect_uri` lands on the API host's
   `/integrations/linear?setup=<key>` and cannot reach the app, so
   `/api/linear-auth/start` answers the cloud's authorize URL carrying the
   listener's port and the app polls `/api/linear-auth/session` for the
   setup key (5 bun tests). `state/seams/LinearSeam.ts` — connect (the
   wizard card), openLinear (handoff → `GET /api/linear/setup/{key}` →
   teams; an expired key reads `authorization expired · Open Linear again`,
   the absent route renders the plue#469 team-pick note), pickTeam,
   pickRepository, confirmConnect (the SAME card turns connected),
   refreshIntegrations, syncNow (202 `sync_started` / 409
   `sync_already_running` are states, not errors; a 422 renders the op
   error verbatim), activity (24h window), disconnect (the connected card
   leaves the transcript), retryOp (the plue#468 refusal — no `/ops` route
   is ever called), showMoreOps. `state/seams/GitHubSeam.ts` absorbs
   `AppStatusSeam.ts` (deleted): app (the status DTO → collection row +
   connector-setup card, `trustedInstallUrl` kept), openInstall, reconcile
   (404 in prod — the platform's words verbatim, the status re-read still
   lands), mirrorSync (202 `{run_id}`; no GET run route is polled,
   plue#470). `readGitHubRefusal` in `SeamContext.ts` parses the structured
   429 (`code: "github_rate_limited"`) into the card's rate-limit facts; a
   plain 429 invents no reset. `RepoImportSeam.ts` routes through
   `/api/cloud/*` like every lane seam (the Worker's platform proxy is the
   old parity surface), parses stage/counts/repository/workspace_id loose,
   and retries through `POST /api/github/import/{id}/retry` (the route
   exists in prod). `IssuesSeam.ts` parses the optional `linear` link off
   the issue DTO and refuses link/unlink with the plue#473 wording — never
   a call. 14 + 16 + 12 seam tests against route doubles, including the
   422 op error and the structured-429 doubles the exit names.
3. **Cards** (`cards/SyncCards.tsx`, `RepoImportCard.tsx`, `IssueCards.tsx`,
   registered in `ChatCards.tsx`). The connector-setup card: step rows that
   fill in, Open Linear on the authorize step, the team pick one click per
   team, the repository pick off the repositories collection (the tree
   from ADR 0001), Connect when key and team are gathered; the connected
   state carries `ENG · Engineering → org/repo`, the last-sync age
   (`ageLabel` in `Timestamps.ts`), and Sync now / Activity / Disconnect.
   The GitHub half: installed `· installation <id> · configured` or the
   install link, Re-check, Reconcile. The sync-ops card: subject, trigger,
   run state and counts only when a run DTO carries them, ops with verbatim
   errors and per-op Retry, the plue#468 note while the feed doesn't
   exist, Show more past the cut. The ADR's rate-limit line (`GitHub rate
   limit reached · 0 of 5,000 · resets … · Retry after`) renders on every
   sync card, and on the GitHub card when the status answer's remaining
   budget drops under a fifth. The import card renders the counts, links
   the done state's workspace (`/workspace.view`), and retries through
   `/repos.import.retry`. The issue card names `Linear ENG-482` linked, or
   offers Link to Linear… — a composer prefill for `/issues.link-linear
   <n> `, allowlisted in parity as a draft edit, never a command. 11 card
   tests.
4. **Flows** (`flows/Flows.ts`, `SlashPayload.ts`, `registry.ts`):
   `linear.connect` / `.connect.open` / `.connect.team` / `.connect.repo` /
   `.connect.confirm` / `.sync` / `.activity` / `.disconnect` (confirming),
   `github.app` (+ hidden alias `repos.app` — the rename the ADR names),
   `github.app.open` / `github.reconcile` / `github.mirror-sync`,
   `sync.retry`, hidden `sync.ops.show-more`, `repos.import.retry`,
   `issues.link-linear` / `issues.unlink-linear` (confirming). The `linear`,
   `github`, and `sync` namespaces joined `NAMESPACES`; registry and
   parity pins updated (the affordance counts pin gained `SyncCards.tsx`:
   12). The integrations list loads on cloud sign-in beside the repository
   inventory.
5. **Connectors surface** (`ConnectorsSurface.tsx`): the rows are Local
   repository / GitHub (`github.app` signed in — the sign-in row's badge
   became the act; sign-in stays the door signed out) / Linear
   (`linear.connect`, per-team state from the loaded integrations) /
   Smithers Cloud (`repos.import`). GitHub's count is only what the app
   has read (`installed on N repositories`). The roving-arrows test
   follows the new truth: every signed-in row action is a button.
6. **T1** (`e2e/playwright/sync.spec.ts`, 3 tests): the connect flow end to
   end through a fake Linear (handoff URL captured off the stubbed
   `window.open`, teams picked, the SAME card turned connected), a sync
   rendering the sync-ops card with the plue#468 note plus the honest
   `sync.retry` refusal, and an import job tracked to done with the
   workspace link. Deviation from the plan: the T1 origin runs offline, so
   the `/api/linear-auth/*` receiver is doubled like every other route
   instead of driven through a real callback — `LinearAuth.ts` itself is
   covered by its own 5 bun tests, and the report's handoff gap (below)
   stands either way.

## Exit gate

- Seam tests: 42 across the three seams, doubles for every route, the 422
  op error and structured-429 doubles included.
- Card tests: 11, per wizard step, connected state, GitHub half, ops rows,
  the degraded note, and the rate-limit line.
- T1: 3 playwright tests, all passing.
- Gates: `tsc --noEmit` clean; `bun test src` 1499 pass / 3 fail — exactly
  the pre-existing TargetGraph integration failures; apps/shared 130 pass;
  apps/server 402 pass. (Full-suite runs occasionally flake the native/PTY
  integration files under parallel load; each passes in isolation, as
  before this lane.)

## Gaps carried (named, not hidden)

- **The Linear handoff cannot complete against prod today.** Every
  `/api/linear*` route is 404 in prod (the whole feature is undeployed),
  so `/api/linear-auth/start` answers the cloud's authorize URL and the
  five-minute wait expires with the honest handoff-failed wording. The
  receiver, the poll, and the wizard are real and tested against doubles;
  the day plue ships the routes, nothing in the app changes.
- **`POST /api/github-app/reconcile` and `/api/repos/{o}/{r}/mirror-sync`
  are 404 in prod** (plue has the latter on main; the admin reconcile only
  is deployed). Both acts surface the platform's own words verbatim; the
  mirror card carries no state word the wire didn't.
- **Import calls moved behind `/api/cloud/*`** for consistency with every
  lane seam; the Worker's curated platform proxy (the old parity surface)
  no longer serves the app's import path. If the Worker-hosted deployment
  must keep importing through it, that is a follow-up proxy rule, not
  seam code.

## Never faked

The ops feed, the per-op retry, and the sync runs (plue#468), the mirror
runs (#470), the import progress fields the wire doesn't carry (#471), the
structured 429's absence on a plain 429 (#472), the reconcile and
issue-linear-link routes (#473), the setup lookup's team list when its
route is missing (#469). Each renders the ADR's wording or refuses with it;
the routes that exist are the only ones called, and every rate-limit fact
came off a wire answer.
