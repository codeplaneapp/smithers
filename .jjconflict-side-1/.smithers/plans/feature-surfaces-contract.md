# Feature surfaces — implementation contract

Porting the remaining `~/gui` Swift views into `apps/smithers` as **mock-data canvas
surfaces**, following the established feature-folder template. This doc is the
authoritative contract. Exhaustive per-feature UX is in
`feature-surfaces-specs.txt` (same folder) — read your feature's section there.

## The template (copy it exactly)

The canonical feature folder is `apps/smithers/src/vcs/` and the list+detail
variant is `apps/smithers/src/issues/`. A surface feature is:

- `<feature>.ts` — domain types + **pure** functions + **deterministic** seed data.
  Multiple exports allowed in a domain file (see `vcs.ts`, `issues.ts`).
- `<feature>Store.ts` — one zustand store (`create<...>((set, get) => ...)`).
- `<Feature>Canvas.tsx` — the surface: root `<section className="surface" data-testid="<feature>-canvas">`
  with `<header className="surface-head">`.
- `<Feature>Card.tsx` — the inline chat card (`.list-card`), with an `Open … ›`
  `.card-link` that calls `openSurface({ kind: "<kind>" })`.
- `<feature>Route.tsx` — `createRoute({ getParentRoute: () => rootRoute, path: "…", component })`.
- `<feature>.css` — feature-scoped styles, **imported at the top of `<Feature>Canvas.tsx`**
  (`import "./<feature>.css";`). CSS imports are global in Vite; this dodges the
  shared-`featureCards.css` multi-writer race. Reuse existing classes first.
- `<feature>Domain.test.ts` — `bun test`, pure functions only, no DOM.

## Hard conventions (CLAUDE.md + repo memory)

- **Zero `useState`, zero `useEffect`.** All state in zustand. Components read
  slices via selectors and compute derived values in the render body.
- **Deterministic seed data only.** No `Math.random`, no `Date.now()`, no
  `new Date()`. Bake a fixed `NOW_MS` constant when you need relative times.
- One primary named export per component/store file; filename matches the export.
- Colocate by feature folder. `index.ts` is barrels only (don't add one).
- Match the surrounding code's idiom, comment density, and naming.
- Reuse the CSS vocabulary (see the bottom of `feature-surfaces-specs.txt`):
  `.surface/.surface-head/.surface-title/.surface-sub/.surface-empty`, `.seg`+`.is-on`,
  `.btn/.btn-brand/.btn-deny/.card-link`, `.list-card/.card-head/.card-icon/.card-title/.card-sub/.card-body/.card-foot`,
  `.list-row/.list-text/.list-name/.list-meta/.list-tags/.mini-tag/.ready-dot`,
  the review list+detail set `.rev-body/.rev-list/.rev-row(.is-on)/.rev-row-main/.rev-row-title/.rev-row-meta/.rev-dot/.rev-num/.rev-empty/.rev-detail(-empty/-head/-title/-actions/-scroll)/.rev-create(-head/-actions)/.rev-prose/.rev-editor`,
  `.field-input(.is-mono/.is-area)`, `.state-badge`, `.kv`, `.tone-ok/.tone-running/.tone-waiting/.tone-failed/.tone-idle`,
  `.status-pill`, `.delta-add/.delta-del`, `.cron-pattern`.
  Add new classes (listed per feature in the spec) in your `<feature>.css`.

## Side-effects pattern (gateway-less PWA)

Mutations echo like `vcsStore`/`issuesStore`: `useChatStore.getState().say("…")`
plus `useNotificationsStore.getState().notify({ title, detail, kind: "transient", command: "chat" })`.

## DO NOT TOUCH (the integrator owns these — touching them causes merge races)

- `app/Surface.ts`, `app/deriveRoute.ts`, `app/navigation.ts`, `app/router.ts`,
  `app/runSlash.ts` — surface kinds, routes, slash wiring are added centrally.
- `cards/Card.ts`, `cards/CardView.tsx` — new card kinds wired centrally.
- `runs/runsStore.ts` — already extended with the engine API you need (below).
  **Consume it; never edit it.**
- `cards/featureCards.css` — use your own `<feature>.css` instead.
- Only the **runs-inspector** agent may edit `cards/cardUiStore.ts`.

## runsStore engine API (already implemented, import and call)

`useRunsStore` exposes: `runs: RunState[]` (each run now has `frame`, `maxFrame`,
`gate`, `paused`, `canceled`), `launch`, `approve(id,note?)`, `deny(id,note?)`,
`cancel(id)`, `resume(id)`, `scrub(id,frame)`, `setPaused(id,paused)`,
`returnToLive(id)`, `step(id,delta)`, `rewindTo(id,frame)`, `fork(id)`.
`selectRun(runs, id)` derives the display `Run` (status/root/frameCount).
`GATE_FRAME = 4`, `AUTH_REFACTOR_FRAMES` (7 frames) in `runs/authRefactorFrames.ts`.

## Surface kinds, routes, slashes (the integrator wires these — your route file & card must match)

| feature | Surface kind | route path | route export (file) | Canvas export | Card export |
|---|---|---|---|---|---|
| runs (list) | `{ kind: "runs" }` | `/runs` | `runsRoute` (`runs/runsRoute.tsx`) | `RunsCanvas` | `RunsCard` |
| approvals | `{ kind: "approvals" }` | `/approvals` | `approvalsRoute` (`approvals/approvalsRoute.tsx`) | `ApprovalsCanvas` | `ApprovalsCard` |
| agents | `{ kind: "agents" }` | `/agents` | `agentsRoute` (`agents/agentsRoute.tsx`) | `AgentsCanvas` | (extend `AgentsCard`) |
| memory | `{ kind: "memory" }` | `/memory` | `memoryRoute` (`memory/memoryRoute.tsx`) | `MemoryCanvas` | (extend `MemoryCard`) |
| prompts (editor) | `{ kind: "prompts" }` | `/prompts` | `promptsRoute` (`prompts/promptsRoute.tsx`) | `PromptsCanvas` | `PromptsEditorCard` |
| scores | `{ kind: "scores" }` | `/scores` | `scoresRoute` (`scores/scoresRoute.tsx`) | `ScoresCanvas` | (extend `ScoresCard`) |
| crons (triggers) | `{ kind: "crons" }` | `/crons` | `cronsRoute` (`crons/cronsRoute.tsx`) | `CronsCanvas` | (rewrite `CronsCard`) |
| workflow editor | `{ kind: "workflowEditor"; id: string }` | `/workflow/$id` | `workflowEditorRoute` (`store/workflowEditorRoute.tsx`) | `WorkflowEditorCanvas` | `WorkflowEditorCard` |
| palette | `{ kind: "palette" }` | `/palette` | `paletteRoute` (`palette/paletteRoute.tsx`) | `PaletteCanvas` | `PaletteCard` |

Note: `Surface` is a separate union from `Card`, so a `{ kind: "agents" }` surface
coexists with the existing `{ kind: "agents" }` *card*. For the `Open …›` link in
your card, call `openSurface({ kind: "<your kind>" })` (import from `app/navigation`).
For the workflow editor card, call `openSurface({ kind: "workflowEditor", id })`.

Enhancement surfaces that already have a route (no new kind): **diff**
(`/runs/$runId/diff/$diffId`, edit `DiffCanvas`), **timeline**
(`/runs/$runId/timeline`, rewrite `TimelineCanvas`), **node inspector**
(inside `RunInspector` at `/runs/$runId`).

## Verification

Run only your own domain test in isolation (`bun test <your test file>`). Do **not**
run a project-wide `pnpm typecheck` — the tree has concurrent writers; the
integrator runs the full typecheck/repair pass after everyone lands.
