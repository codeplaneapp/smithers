# Lane `citc` — REPORT

Brief: `citc.md`. ADR: `../decisions/0002-citc-sandbox-kinds.md`. Status: all
six steps shipped and green; the lane's gates pass, and the only failures in
the tree are the three pre-existing TargetGraph integration tests plus two
`runs.rerun` tests from a concurrent runs-lane commit (below).

## What shipped, per step

1. **Shared schemas** (`apps/shared/src/Cards.ts`): the `workspace` card
   payload — workspaceId, repo, name, targetBookmark, the six statuses,
   provisioningStage, suspendedAt (optional so older cards parse),
   `bookmarkHead { changeId, commitId } | null` (the TARGET BOOKMARK's head,
   never the workspace's), snapshots[], sessions[], facet,
   terminalSessionId, error — and the `service-log` payload (lands with the
   contract; no flow produces it until plue#449). No kind, no uptime, no
   workspace head, no ahead/behind (plue#446). `CLOUD_WS_ROUTE_PREFIX`
   (`/api/cloud-ws/`) joined `apps/shared/src/LocalApp.ts`.
2. **Model + seam.** `cloudWorkspaces` collection (`app-cloud-workspaces`,
   registered in `SchemaVersion.ts`) as the authority; `workspaces.loaded`
   (per-user or per-repo scope replace) and `workspace.updated` upsert AND
   re-sync the `workingCopies` rows piper added (`workspace:<id>`, kind
   workspace, `label · state`) in the same transaction.
   `state/seams/WorkspaceSeam.ts` covers every plue route — per-user and
   per-repo list, get, create-or-reuse per bookmark, delete, suspend,
   resume, fork, snapshot create/list/delete/template, fork-from-snapshot,
   sessions list/destroy — plus a settle watch that polls a
   pending/starting workspace until it settles, re-reading the repo list on
   a 404. A bare act resolves the active workspace copy, else the single
   loaded workspace, else an honest choice. Every act gates on the cloud
   session: signed-out refuses with the sign-in step; `degraded` refuses
   with the exact "sign in again to enable" wording. 23 seam tests against
   route doubles.
3. **The `workspace` card** (`cards/WorkspaceCard.tsx`, registered in
   `ChatCards.tsx` with the payload-status pill; `starting`/`suspended`
   joined `@smthrs/ui`'s status vocabulary). Header `repo · bookmark ·
   bookmark head @ <id>` — labeled as the bookmark's head. Facet strip
   Terminal / Files / Services / Snapshots: Terminal shows the attachment,
   every session with Destroy, and Open terminal; Files and Services render
   EMPTY with the plue#449 wording; Snapshots rows carry Fork from, Make
   template, Delete. Footer Suspend or Resume, Fork, Snapshot, Delete behind
   a typed confirm (the workspace's name typed back). Starting streams
   provisioningStage; failed names the stage and offers Retry
   (`workspace.open` again); an act's refusal stays on the card. 10 card
   tests across statuses and facets. The terminal runs over plue's ticketed
   WebSocket through the Bun tunnel: `/api/cloud-ws/repos/{o}/{r}/workspace/
   sessions/{id}/terminal` authorizes like `/ws` (origin + the local-session
   subprotocol — a browser upgrade carries no custom header), and Bun
   bridges frames both ways with the Bun-held bearer and plue's `terminal`
   subprotocol attached upstream (`src/bun/server.ts`, 4 tunnel tests). The
   renderer's `CloudTerminalClient` mirrors PtyClient (queue-before-open,
   reconnect while attached; 4 tests); a workspace terminal tab carries
   `workspaceId` + `repo` instead of `cwd`, closing it detaches (never
   DELETEs), and `tab.read` refuses it honestly.
4. **Flows.** `workspace.list [owner/repo]`, `workspace.open [bookmark]
   [repo]` (`outbound:launch`), `workspace.view <id>`, `workspace.terminal`,
   `workspace.suspend|resume|fork|snapshot` (confirm), the hidden id-scoped
   `workspace.snapshot.delete`, `workspace.snapshot.fork`
   (`outbound:launch`), `workspace.session.destroy`, `workspace.delete`
   (confirms), `workspace.template`, `workspace.sessions`, and the
   user-only `workspace.facet` — slash payloads, and the registry, parity
   (WorkspaceCard pinned at 13 handlers, `setDeleteDraft` allowlisted as
   presentation state), and invocable pins updated.
5. **Tree rows.** A workspace copy under its repo reads `name · state`
   (piper's renderer; the citc collection now feeds it) and selecting it
   makes it the active working copy — asserted in the T1 spec
   (`copy-workspace:ws-1` reads `review · running`).
6. **Docs.** `LOCAL-APP.md` cards section (the lane's paragraph) and
   `WORKBENCH-UX.md` §3.1 (a status note: what landed, what waits on plue
   Phase B / #449 / #446, which flows are registered).

## Decisions worth knowing

- **`cloudWorkspaces` is the authority, `workingCopies` the projection.**
  The name `workspaces` was taken (the frame-graph collection), so the new
  collection is `app-cloud-workspaces`; copy rows derive from it in the
  same dispatch transaction, so the tree and the card never disagree.
- **Acts never invent a status.** Suspend/resume trust the act's returned
  DTO; when plue answers without one, the seam re-reads the workspace, and
  failing that refreshes the repo list — never an assumed `suspended`.
- **A deleted workspace's card leaves the transcript** (`card.removed`):
  any status it could show afterward would be a lie; the delete itself is
  journaled.
- **A destroyed session detaches the card** that pointed at it
  (`terminalSessionId` cleared), so the facet re-offers Open rather than
  claiming a dead attachment.
- **The watch polls, it does not stream.** plue's SSE route is not proxied
  yet; the brief allowed poll. pollMs is injectable (tests run it at 1ms).
- **Bun's WS client carries the upstream subprotocol as a header.** Its
  options form takes `headers` but not `protocols`;
  `sec-websocket-protocol: terminal` goes in as a plain header (verified
  against a live double).

## Gates

- `pnpm exec tsc --noEmit` (apps/ui, apps/shared, packages/ui) — clean.
- `bun test src` (apps/ui) — 1362 pass; 5 fail: the 3 pre-existing
  `src/bun/TargetGraph.integration.test.ts` failures (the `~/artsy/force`
  fixture, failing on a clean checkout) and 2 `runs.rerun` tests broken by
  the concurrent runs-lane commit `75ed77754c` ("runs.rerun refuses a run
  that is not settled"), which changed `controller/runs.ts` without
  updating `Runs.test.ts` — not this lane's files, left for that lane.
- `bun test` (apps/shared) — 123 pass; (apps/server) — 402 pass;
  (packages/ui) — 1262 pass.
- T1 `e2e/playwright/citc.spec.ts` — 2 pass: open → card → starting→running
  stream → snapshots facet → tree row; degraded refusal with the exact
  wording in the toast.

## Follow-ups (not this lane)

- `plue#446` (kind, uptime, workspace head, ahead/behind): the card and the
  collection carry none; when the DTO grows them, the payload schema and
  the header line grow with it.
- `plue#449` (workspace file/service routes): Files and Services facets
  render the ADR's empty wording; the `service-log` payload already waits
  in the shared schema, and `workspace.services`/`workspace.logs` register
  when the routes exist.
- The Desktop facet waits on plue Phase B (WORKBENCH-UX §3.1 status note).
- plue's SSE status route could replace the settle watch's poll when it is
  proxied.
- The 2 `runs.rerun` test failures belong to the runs lane (commit
  `75ed77754c`); its tests were not updated with the behavior change.
