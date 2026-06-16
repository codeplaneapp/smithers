# e2e + unit coverage matrix

This is the catalog of automated tests covering every current UI surface in
`apps/smithers`. The Playwright suite runs against the real fixture stack
(`tests/fixtures/*.ts`) — no route mocks, no fabricated data — so coverage
reflects real behavior. Unit tests use `bun test`.

## Surfaces and their tests

| Surface              | URL                       | Playwright spec                | Unit / domain                   |
| -------------------- | ------------------------- | ------------------------------ | ------------------------------- |
| App shell smoke      | `/`                       | `smoke.spec.ts`                | —                               |
| Chat (gateway path)  | `/`                       | `chat.spec.ts`                 | —                               |
| Composer controls    | `/`                       | `composer.spec.ts`             | —                               |
| Command menu         | `/` (View nav)            | `nav.spec.ts`, `commandMenuKeyboard.spec.ts` | `navMenu.test.ts` |
| Layout / rail        | `/`                       | `layout.spec.ts`, `rail.spec.ts` | —                             |
| Theme                | `/`                       | `theme.spec.ts`                | —                               |
| Sign-in modal        | `/`                       | `signIn.spec.ts`               | `auth/authClient.test.ts`       |
| Login page           | `/login`                  | `loginPage.spec.ts`            | —                               |
| Onboarding           | `/` (first run, overlay)  | `onboarding.spec.ts`           | `onboarding/onboardingStore.test.ts`, `onboarding/createWorkflowFlow.test.ts` |
| Apps dock            | bottom edge               | `dock.spec.ts`                 | `apps/appCatalog.test.ts`, `apps/dockStore.test.ts` |
| Notifications stack  | corner stack              | `toasts.spec.ts`, `notificationsStack.spec.ts` | `notifications/notificationsStore.test.ts` |
| Feature cards (chat) | `/` slash commands        | `featureCards.spec.ts`         | per-feature domain tests        |
| Launch a run         | `/` (`ship …` / `/run …`) | `launchRun.spec.ts`            | `runs/runDomain.test.ts`        |
| Approval gate        | chat + watcher            | `approvals.spec.ts`            | —                               |
| Runs canvas          | `/runs`                   | `runsCanvas.spec.ts`           | `runs/runsListDomain.test.ts`, `runs/runsListStore.test.ts` |
| Run inspector        | `/runs/$runId`            | `runsCanvas.spec.ts`           | `runs/runDomain.test.ts`        |
| Logs / timeline      | `/runs/$runId/{logs,timeline}` | `surfaces.spec.ts`        | `runs/logs/logsScores.test.ts`  |
| Diff card            | chat                      | `diffVcs.spec.ts`              | —                               |
| VCS card             | chat                      | `diffVcs.spec.ts`              | —                               |
| Agents canvas        | `/agents`                 | `agentsCanvas.spec.ts`         | `agents/agentsDomain.test.ts`, `agents/agentsCrons.test.ts` |
| Crons canvas         | `/crons`                  | `cronsCanvas.spec.ts`          | `crons/cronsDomain.test.ts`     |
| Memory canvas        | `/memory`                 | `memoryCanvas.spec.ts`         | `memory/memoryDomain.test.ts`   |
| Prompts canvas       | `/prompts`                | `promptsCanvas.spec.ts`        | —                               |
| Scores canvas        | `/scores`                 | `scoresCanvas.spec.ts`         | —                               |
| Issues canvas        | `/issues`                 | `reviewSurfaces.spec.ts`       | —                               |
| Tickets canvas       | `/tickets`                | `reviewSurfaces.spec.ts`       | —                               |
| Landings canvas      | `/landings`               | `reviewSurfaces.spec.ts`       | —                               |
| Workflow store       | `/store`                  | `store.spec.ts`                | `store/workflows.test.ts`       |
| Workflow editor      | `/workflow/$id`           | `workflowEditor.spec.ts`       | `store/workflowEditorDomain.test.ts` |
| Ask Me               | `/askme`                  | `askme.spec.ts`                | —                               |
| Gateway custom UI    | `/gw/$key/$runId`         | `gatewayUi.spec.ts`, `gatewayRun.spec.ts` | —                    |
| Mobile shell         | viewport 390×844          | `mobileViewport.spec.ts`       | —                               |

## Explicit corner cases covered

- **Empty states**: runs canvas with no matches, memory recall with no query,
  workflow editor on an unknown id, issues/tickets/landings canvases with no
  selection.
- **Loading / mid-action states**: approval gate while pending, prompts preview
  while rendering, run engine while running/waiting.
- **Error states**: cron canvas validation banner, /memory recall error state,
  failed-run resume affordance.
- **Large lists**: runs canvas filters down a multi-status roster, agents canvas
  lists every seeded account, crons canvas adds rows then deletes them.
- **Long text**: seeded run titles like "Implement · auth refactor" exercise
  the card heading overflow; the prompts editor accepts long fills.
- **Keyboard nav**: composer Escape closes the project menu and returns focus;
  command menu Enter opens / Escape closes / focus restored
  (`commandMenuKeyboard.spec.ts`).
- **Route deep links**: every canvas surface mounts cleanly from a fresh
  navigation (`deepLinks.spec.ts`), and `/agents` survives a reload.
- **Stale-update prevention**: runsListStore approve/deny/resume no-op on
  unknown ids and on rows whose status doesn't match the action; notifications
  store dismiss/update no-op on unknown ids.
- **Mobile / desktop viewports**: `mobileViewport.spec.ts` covers home, store
  header, and the runs canvas at 390×844; the rest of the suite runs Desktop
  Chrome.

## Running

```
pnpm --filter ./apps/smithers typecheck             # types green
pnpm --filter ./apps/smithers test:unit             # unit + domain
pnpm --filter ./apps/smithers exec playwright test  # e2e (real fixtures)
```
