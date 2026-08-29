# Actions gap: multi → mvp

**Status 2026-08-12.** Tier 1 and Tier 2 below are largely SHIPPED as commands

- seams (`src/mainview/state/seams/*`) + cards (`src/mainview/cards/*`) behind
  the Worker's curated platform proxy (`src/worker/index.ts`
  PLATFORM_PROXY_RULES): repos.import, issues.list/view/create/close/reopen/
  comment, prs.list/view/land/review, billing.upgrade/portal, keys.list/remove,
  notifications.list/read, env.view/set. Wave 2 (same day): branches.list,
  files.list/read, repos.app (GitHub App status), prs.create (full bookmark +
  change-stack assembly — closed smithersai/mvp#20), issues source-only fallback
  via /api/user/github-repos (import-readiness rule), mid-session 401 recovery
  in the tapped fetch, and /api/client-errors ingest. Deferred to issues:
  `keys.add` (masked secret-entry card, smithersai/mvp#19) and push
  notifications (service-worker + native design pass, smithersai/mvp#21).
  Crons remain unimplemented (gateway RPC — waits for new flows).

**Flows-dependency rule.** Everything riding multi's old gateway RPC plane
(`/v1/rpc/*`): evals, scores, optimize, guardian, tickets, crons, run
cancel/resume/rewind, prompts, docs — waits for the new flows runtime
(`../flows/flows`) rather than porting the legacy RPC surface. The shipped
Tier 1/2 actions are plain platform REST and carry no flows dependency.

Multi (`/Users/williamcory/multi`) ships 359 flow commands against the same
backend this app uses. This document lists the user actions multi implements
that mvp does not, mapped onto mvp's command registry, with the registration
contract every new action must follow.

Sources: multi's flow registry (`src/flows/*/command.ts`, discovered via
`src/flows/registry.ts`), its typed clients (`src/smithersCloud/*.ts`), and its
Worker route table (`src/worker.ts:3116`). mvp's registered surface is the 43
commands in `src/mainview/commands/Commands.ts`.

## The registration contract (follow this for every new action)

1. **One command per action** in `src/mainview/commands/Commands.ts`:
   `name`, `summary`, `acceptsArgs`/`args`, `hidden` for id-scoped button
   actions, `trigger: "user"` for browser mechanics the agent must never call.
2. **Declare prerequisites with `requires`** (`registry.ts
   commandRequirements`), never with ad-hoc checks inside `execute`. A
   user-invoked command with an unmet requirement parks durably
   (`session.pendingCommand`), the fulfilling command runs in its place
   (sign-in, repo chooser), and the parked command resumes when the
   requirement's predicate flips true — across the OAuth redirect. Agent
   invocations fail honestly with the reason instead of parking. Requirements
   resolve one at a time against live state, so chains (sign in → choose
   repos → run) come free.
3. **Adding a requirement id** means adding its entry to
   `commandRequirements` (predicate over `CommandState`, fulfilling command,
   honest reason) and calling `resumeDeferredCommand()` from every seam that
   can satisfy it (today: identity load, watched-repos confirm).
4. **The controller owns the seam**: one `AppController` method per backend
   interaction, dispatching typed transitions; results render as cards or
   messages, never raw strings (§2b).
5. **Every affordance is a command**: buttons carry `data-command`,
   `parity.test.ts` gates handler routing and re-pins the per-file affordance
   counts.
6. **Tests**: seam behavior with a stubbed backend (`Wave10Chat.test.tsx`
   pattern), requirement behavior in `commands/requirements.test.ts`, and the
   registered-name list in `registry.test.ts`.

Multi's equivalent (for reference, not imitation): auth gating lives inside
each flow's `execute` or in bridge components (`src/flows/repo/command.ts:33`,
`src/issues/IssuesBridge.tsx:14`), plus a global 401 → `handleAuthRequired()`
listener. mvp's `requires` axis replaces that with declared, resumable
dependencies.

## Gap list

Grouped by domain. "Route" is the backend surface multi already uses (the
Worker proxies `/api/**` to the platform with an injected bearer). Multi
reference files are under `/Users/williamcory/multi`.

### Tier 1 — core product actions (implement first)

| Proposed mvp command             | Requires                  | Route(s)                                                                                                | Multi reference                                            |
| -------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `repos.import`                   | signed-in                 | `POST /api/github/import`, poll/SSE `GET /api/github/import/{id}`                                       | `src/smithersCloud/githubImport.ts:196`                    |
| `issues.list`                    | signed-in, repos-selected | `GET /api/repos/{o}/{r}/issues` (imported) or `GET /api/user/github-repos/{o}/{r}/issues` (source-only) | `src/flows/list-issues`, `src/smithersCloud/issues.ts:189` |
| `issues.view`                    | signed-in, repos-selected | `GET …/issues/{n}`, `GET …/issues/{n}/comments`, `GET …/issues/{n}/events`                              | `src/flows/get-issue`                                      |
| `issues.create`                  | signed-in, repos-selected | `POST …/issues`                                                                                         | `src/flows/create-issue`                                   |
| `issues.close` / `issues.reopen` | signed-in, repos-selected | `PATCH …/issues/{n}`                                                                                    | `src/flows/close-issue`, `reopen-issue`                    |
| `issues.comment`                 | signed-in, repos-selected | `POST …/issues/{n}/comments`                                                                            | `src/flows/comment-on-issue`                               |
| `prs.list`                       | signed-in, repos-selected | `GET …/landings` + `GET /api/user/github-repos/{o}/{r}/pulls`                                           | `src/flows/list-pull-requests`                             |
| `prs.view`                       | signed-in, repos-selected | `GET …/landings/{n}`, `…/diff`, `…/comments`, `…/reviews`, `GET …/commits/{ref}/statuses`               | `src/smithersCloud/landings.ts`                            |
| `prs.create`                     | signed-in, repos-selected | `POST …/landings`                                                                                       | `src/flows/create-pull-request`                            |
| `prs.land`                       | signed-in, repos-selected | `PUT …/landings/{n}/land` — answers 202/queued; the card must say "queued", never "merged"              | `src/flows/land-pull-request`                              |
| `prs.review`                     | signed-in, repos-selected | `POST …/landings/{n}/reviews` `{type, body}`                                                            | `src/flows/submit-pull-request-review`                     |
| `billing.upgrade`                | signed-in                 | `POST /api/billing/checkout` `{plan}` → Stripe URL                                                      | `src/flows/start-billing-checkout`                         |
| `billing.portal`                 | signed-in                 | `POST /api/billing/portal` → portal URL                                                                 | `src/flows/open-billing-portal`                            |
| `run.cancel` / `run.resume`      | signed-in, repos-selected | gateway RPC `cancelRun` / `resumeRun` (`POST /v1/rpc/…`)                                                | `src/flows/cancel-run`, `resume-run`                       |
| `runs.list`                      | signed-in, repos-selected | gateway RPC `listRuns`                                                                                  | `src/runs/runsListStore.ts`                                |

Notes:

- mvp already watches runs via cards (`workflow.run.stop` stops the WATCH);
  `run.cancel` stops the RUN itself — distinct act, distinct command.
- Multi's two repo namespaces matter: `/api/user/github-repos/**` is
  metadata for any repo the user can read (no import); `/api/repos/{o}/{r}/**`
  404s unless imported. `src/smithersCloud/importReadiness.ts` encodes the
  classification — port that rule before wiring issues/PRs.

### Tier 2 — settings and account surfaces

| Proposed mvp command                                        | Requires                  | Route(s)                                                                                | Multi reference                         |
| ----------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------- |
| `keys.list` / `keys.add` / `keys.remove` (BYOK)             | signed-in                 | `GET/POST /api/user/byok-keys`, `DELETE …/{provider}`                                   | `src/smithersCloud/byokKeys.ts`         |
| `env.view` / `env.save`                                     | signed-in, repos-selected | `GET/PUT /api/repos/{o}/{r}/agent-environment`                                          | `src/smithersCloud/agentEnvironment.ts` |
| `env.secret.set` / `env.secret.delete`                      | signed-in, repos-selected | `PUT/DELETE …/agent-environment/secrets/{name}`                                         | same                                    |
| `notifications.list` / `notifications.read`                 | signed-in                 | `GET /api/notifications/list`, `PUT /api/notifications/mark-read`                       | `src/smithersCloud/notifications.ts`    |
| `push.enable` / `push.disable` (native app)                 | signed-in                 | `GET /api/push/public-key`, `POST /api/push/subscribe`, `DELETE /api/push/devices/{id}` | `src/push/pushClient.ts`                |
| `cron.create` / `cron.delete` / `cron.toggle` / `cron.list` | signed-in, repos-selected | gateway RPC `cronCreate` / `cronDelete` / `cronUpdate` / `cronList`                     | `src/flows/create-cron` etc.            |

### Tier 3 — larger subsystems (decide product fit first)

- **Tickets** (`createTicket`/`updateTicket`/`deleteTicket`/`listTickets` RPC,
  plus GitHub-issue import/export) — multi `src/flows/create-ticket` etc.
- **Files surface** (contents read, diffs, drafts with CAS write and
  commit) — multi `src/files/filesClient.ts`, `fileDraftsClient.ts`.
- **Branches/VCS** (bookmarks list/set, status, branch locks with
  heartbeat/join-requests) — multi `src/smithersCloud/bookmarks.ts`,
  `branchLocks.ts`. Locks are multiplayer machinery; skip until Pair-like
  sharing is in scope.
- **Pair multiplayer sessions** (~20 actions, `/api/pair-sessions/**`) —
  gated on a paid plan upstream.
- **Workspaces/terminal** (`POST /api/repos/{o}/{r}/workspaces`, terminal WS
  sessions with SSE tickets) — powerful with the native shell; needs its own
  design pass.
- **Evals/scores/optimize/prompts/docs/guardian** — gateway RPC families;
  admin-plugin candidates rather than base commands.
- **Backend memory** (`/api/{user,repos}/…/memory/**` recall/retain/browse) —
  overlaps mvp's local World; decide whether World syncs to it or stays
  local before porting commands.

### Already covered in mvp (no port needed)

Sign-in/out (`auth.*`), access requests (mvp has a real request-access seam;
multi's main app has none — its waitlist is a redirect-param dance), repo
watching/selection (`repos.watch*`), workflow create/list/run + run cards,
approvals on cards (`approval.*`), balance (`billing.balance`), browser cards,
theme, clear, world notes, connectors, admin allowlist/grants/health, chat.

## Requirement ids to add as tiers land

| Id                     | Predicate (CommandState)                                                          | Fulfill                                        | Needed by                              |
| ---------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------- |
| `repo-imported`        | selected repo classified imported (new state field fed by import-readiness probe) | `repos.import`                                 | issues/PR mutations, agent-environment |
| `github-app-installed` | app-status probe answer (new state field)                                         | new `repos.app.install` command (external nav) | landings that need checks              |
| `paid-plan`            | billing state ≠ free (billing snapshot)                                           | `billing.upgrade`                              | pair, branch-lock joins                |

Each addition follows contract rule 3: table entry + resume call at the
satisfying seam.
