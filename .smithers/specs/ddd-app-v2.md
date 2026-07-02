# DDD App v2: docs-first product spec app, in smithers and in multi

Status: approved design, 2026-07-02.
Scope: two repos. `/Users/williamcory/smithers` (canonical DDD pack) and
`/Users/williamcory/multi` (the product UI, where DDD becomes the premier app).

## Why

The docs-driven-development (DDD) pack shipped 2026-07-02 (commit 4310f042ac)
works but has four problems:

1. The Docs tab shows every generated low-level doc next to the product
   overview. Humans read generated reference material they should be handing
   to their agent.
2. The pack only improves an existing spec. There is no way in: no "create a
   new app" entry and no "generate the spec from my existing code" entry.
3. Nothing hunts for bugs. Tickets only appear from spec gaps already recorded
   in features.json.
4. It is repo-local tooling. It is not an app in multi, has no first-run
   tutorial, and has no multiplayer.

Alongside that, multi is hard-wired to jjhub. Running it without the cloud
means dead sign-in and dead surfaces instead of a smaller, honest app.

## Design at a glance

smithers repo (canonical pack):

- Docs get a `level`: product docs for humans, technical docs for agents.
  Technical docs collapse behind a menu with explicit "ask your agent to read
  these" guidance.
- Two new seeded-style workflows: `ddd-generate-docs` (build features.json +
  overview from the real code and docs) and `ddd-bug-scan` (async read-only
  bug hunt that files tickets). generate-docs launches bug-scan detached when
  it succeeds.
- A Start screen in the DDD UI when the spec is missing or a stub: "Create a
  new app" (launches `create-workflow` to author a builder workflow for the
  app) and "Generate docs from this repo" (launches `ddd-generate-docs`).
- A first-launch guided tutorial in the DDD UI, told over a hello-world app,
  replayable from a help button.
- Workflow simplification: one ticket pipeline, one status vocabulary, shared
  repo-root resolution from lib, dead 8-slot generality removed,
  `ddd-quality-loop` and `ddd-test-coverage` merged into one parameterized
  `ddd-improve` loop.

multi repo:

- DDD becomes the premier app: AppId `docs`, first in the catalog, a `/docs`
  surface that wraps the workflow UI with app chrome, entry actions, tutorial,
  and a multiplayer presence/collab bar.
- Multiplayer rides the existing pair_state data plane (presence + collab
  editing of the editable spec docs). No new backend tables.
- A plugin architecture: core app runs fully local against the workspace
  gateway; every jjhub/cloud feature moves behind a `jjhub` plugin registered
  in one line. Local-only is a build mode, not a fork.

## Part 1: smithers repo

### 1.1 Docs hierarchy: product vs technical

`lib/ddd/generateUiModules.ts` stamps each bundled doc with
`level: "product" | "technical"`:

- product: `content/overview.md` and anything under `content/product/`.
- technical: `content/features/*` (derived) and `content/reference/*`.

`ddd-docsContent.generated.ts` carries the field. The Docs tab renders:

- Product docs as the primary list, selected by default.
- A collapsed "Technical docs (for agents)" section. Expanding it shows a
  callout before the file list:

  > These are generated, low-level reference docs. Don't read them yourself:
  > ask your agent to read them, e.g. "Read .smithers/spec/content/features/
  > cli.md and fix the failing test it describes." Stay on the product docs;
  > your agent works down here.

- Technical docs stay openable and searchable; the point is default emphasis,
  not access control. Derived docs stay read-only in the editor (they are
  regenerated every build); only product docs are editable and dispatchable.

### 1.2 Workflow simplification (docs-driven-development.tsx)

Behavior-preserving cleanups, no graph shape change:

- `resolveRepoRoot` comes from `lib/ddd/dddRoot.ts` (all three workflows
  currently inline their own copy).
- The metaTicket object shape is declared once and reused by inputSchema and
  the metaTicket output schema.
- `featuresStillIncomplete` counts exactly the schema's open statuses
  (`broken | partial | missing-tests | missing`); the impossible
  `missing-docs` case goes away.
- Slot generality collapses to what runs: one work slot. Schemas keep
  `slot` for forward-compat but the 1..8 ceremony and `agentForSlot`'s dead
  branches go.
- The UI stops synthesizing tickets client-side from triage output
  (`ticketsFromTriage`); materialized tickets from the run plus the generated
  backlog are the two honest sources. Merge order: gateway tickets, then
  materialized, then backlog.

`ddd-quality-loop.tsx` + `ddd-test-coverage.tsx` merge into
`ddd-improve.tsx` with input `focus: "quality" | "tests"`: same skeleton
(codex find -> gated fable second-opinion -> codex implement -> compute
verify), prompts and verify commands switch on focus. The two old files are
deleted; any live runs are cancelled first (editing a running workflow's
source corrupts the run).

### 1.3 ddd-generate-docs (spec from existing code)

New workflow, one-shot (no loop):

1. `survey` (compute): bounded repo inventory. README, docs listing, package
   manifests, top-level src tree, test layout. No recursive dumps.
2. `draft-spec` (agent, fable/planner): read the survey plus targeted files
   and write/merge `.smithers/spec/features.json` honestly (statuses reflect
   proof, not hope) and `content/overview.md` if missing or stub. Existing
   records are updated, never blindly replaced.
3. `build` (compute): `bun .smithers/lib/ddd/build.ts` gate.
4. `review` (agent, fable): adversarial pass; statuses must be defensible
   from cited evidence. Returns approved plus corrections applied.
5. `kickoff-bug-scan` (compute): on success, `smithers workflow run
   ddd-bug-scan --detach` so the bug hunt runs async and durable, with the
   runId recorded in the node output for the UI to follow.

### 1.4 ddd-bug-scan (async initial sync)

New workflow. Read-only hunt, ticket writer:

1. `scan` (agent, codex): bounded bug hunt over the product surface (start
   from `bun .smithers/lib/ddd/auditInputs.ts`, then targeted reads). Output:
   up to N findings {id, title, severity, file, evidence, suggestedFix}.
2. `verify` (agent, fable): adversarially confirm or kill each finding.
   Plausible-but-unproven findings die here.
3. `file-tickets` (compute): confirmed findings become real ticket markdown in
   `.smithers/tickets/` (same shape materialize-tickets writes) and matching
   `missing[]` entries in features.json, then rebuild. No duplicate filing:
   findings keyed by file+title hash, skipped if a ticket already exists.

### 1.5 UI: Start screen, entries, tutorial

Start screen. When features.json is absent or the seeded single-feature stub,
the UI opens on a Start pane instead of Features:

- "Create a new app": prompt box, then `launchRun({workflow:
  "create-workflow", input: {prompt: "Create a workflow named build-<slug>
  that scaffolds and iteratively builds <description>, docs-first: it
  maintains .smithers/spec/features.json for the new app as it builds."}})`.
  The pane then links to the create-workflow run UI
  (`/workflows/create-workflow?runId=...`, same origin) and follows status
  via useGatewayRun. The result: a new app plus a smithers workflow that
  builds it.
- "Generate docs from this repo": `launchRun({workflow:
  "ddd-generate-docs"})`, follow the run, and when kickoff-bug-scan reports
  the detached runId, surface "bug scan running" with a link.

Both actions stay available later behind a "+ New" menu in the header.

Tutorial. First launch (per browser) opens a guided overlay: five steps over
a canned hello-world app spec (a three-feature features.json snippet rendered
inline, not the real spec): what a feature record is, how status must be
earned, editing the overview and dispatching agents, where tickets come from,
watching the run live. Replayable from a "?" button. Persistence:
`localStorage("ddd.tutorial.done")` inside try/catch; in a sandboxed iframe
(multi embeds workflow UIs with an opaque origin, no storage) the flag falls
back to in-memory and the host page owns persistence (see 2.3).

### 1.6 What does not change

- features.json schema (featuresSchema.ts) is untouched except doc-level
  bundling metadata, which lives in generateUiModules output, not the schema.
- The improvement loop's graph (bootstrap -> metaTicket -> audit ->
  spec-update -> triage -> materialize-tickets -> work -> review -> summary)
  survives; it is proven. Simplification is in the flesh, not the skeleton.
- No seeding into `smithers init` yet. The pack generator only ships
  workflows + prompts; extending it to spec/lib/ui pack files is follow-up.

## Part 2: multi repo

### 2.1 DDD as the premier app

- `AppId` gains `"docs"`; the entry goes first in `APPS` with
  `workflowIds: ["docs-driven-development", "ddd-generate-docs",
  "ddd-bug-scan", "create-workflow"]` (resolved live; unresolved ids drop
  silently, which is honest on a small gateway).
- New `Surface` kind `docs` -> route `/docs` -> `DocsCanvas`.
- `DocsCanvas` is multi-native chrome around the embedded workflow UI
  (`WorkflowRunUi` iframe, workflow `docs-driven-development`): a header with
  the app name, entry actions (Create app / Generate docs, which launch runs
  through the same gateway client the rest of multi uses), a link to the
  freshest DDD run, and the collab bar (2.2).
- Slash `/docs` opens the app. The concierge gets a real `openApp` tool
  (id-validated against the catalog) so it can open any dock app; today it
  can only navigate to three views. New capability through the concierge, per
  AGENTS.md rule 1.
- Multi's own `.smithers` DDD fork stays the workspace workflow the iframe
  serves. The UI improvements (docs levels, Start pane, tutorial) are ported
  to multi's fork with its paths (docs/spec, bootstrap-vocs node ids). The
  two forks are acknowledged tech debt; unifying them is out of scope here.

### 2.2 Multiplayer

Ride pair_state; add nothing to the backend. A "Collaborate" toggle in
DocsCanvas joins the pair room (existing key/room model) and:

- shows presence pills (who is here) from pair presence,
- opens editable spec docs (overview.md, content/product/*) in the existing
  pair CodeMirror collaborative editor, with `file_path` = the doc's repo
  path, so cursors, version-gated last-writer-wins, and the typing strip all
  work exactly as they do in Pair today,
- leaves the generated technical docs read-only.

Cursor scoping token = the doc path (already the convention). Presence
heartbeats already carry the whole slice; no protocol change. Cloud or local
docker stack both work because Pair already supports both.

### 2.3 Tutorial in multi

DocsCanvas owns first-open tutorial state (zustand + persist, following
`src/onboarding` conventions: overlay, module-level timers, no useEffect
loops). It reuses the same hello-world script content as the workflow UI
tutorial. The iframe's own tutorial stays dormant in multi (opaque origin
means it cannot persist; the host appends `?tutorial=off` to the iframe URL
once its own tutorial is done, and the workflow UI honors that param).

### 2.4 Plugin architecture and local-only mode

Goal: multi core runs fully local with zero jjhub config; jjhub is a plugin.

`src/plugins/Plugin.ts`:

```ts
export interface MultiPlugin {
  id: string;
  /** Apps contributed to the catalog (dock, store grid). */
  apps?: App[];
  /** Routes contributed to the router. */
  routes?: (rootRoute: RootRoute) => AnyRoute[];
  /** Always-mounted bridge components (data sync, probes). */
  bridges?: ComponentType[];
  /** Slash commands. */
  slashes?: SlashSpec[];
  /** Concierge tools. */
  agentTools?: AgentToolSpec[];
  /** Gate: given the runtime env, is this plugin on? */
  enabled: () => boolean;
}
```

`src/plugins/registry.ts` assembles the enabled plugins once at boot;
`appCatalog`, `router`, AppShell bridge mounting, `runSlash`, and
`agentTools` consume the assembled result instead of their own static lists.
The AppId union stays closed (type safety); plugins contribute entries whose
ids are already in the union.

Core (always on): chat/concierge, runs (gateway backend), files, terminal,
vcs (local repo), docs app, onboarding, store, approvals, agents, memory,
prompts, scores, crons.

`jjhubPlugin` (one registration line): auth (GitHub OAuth sign-in, session,
waitlist), landings, issues (platform backend), repos/notifications import,
platform runs backend, uiPreview, Pair cloud defaults. `enabled()` reads
`import.meta.env.VITE_MULTI_MODE !== "local"` plus the existing env seams.

Local-only mode = `pnpm dev:local` / `pnpm build:local` (VITE_MULTI_MODE=
local). In local mode: no Worker assumed; vite dev proxies to jjhub prod
hosts are disabled (no accidental cloud traffic); sign-in UI absent; runs
backend is the workspace gateway; Pair collab available only if a local
Electric stack is up, else the Collaborate toggle degrades honestly to "not
connected". Removing jjhub is deleting one registry line; adding it back is
adding it back.

Migration is mechanical and incremental: each jjhub-coupled surface already
lives in its own module with env seams (AUTH_API_BASE_URL, GO_API_BASE_URL,
ELECTRIC_BASE_URL, GATEWAY_BASE_URL). The plugin interface formalizes the
seams; it does not invent them.

## Sequencing

1. smithers: cancel live ddd loops, simplify workflow + lib, docs levels,
   generated modules.
2. smithers: ddd-generate-docs + ddd-bug-scan workflows.
3. smithers: UI Start pane + technical-docs menu + tutorial. Gates: bun
   lib/ddd/build.ts, pnpm typecheck, bun test (.smithers), pnpm test.
4. multi: plugin registry + jjhubPlugin extraction (no behavior change in
   cloud mode), local mode scripts.
5. multi: docs app (AppId, surface, DocsCanvas, slash, openApp tool),
   tutorial, collab bar; port UI improvements into multi's DDD fork.
6. Both repos: typecheck + unit + targeted e2e green, docs bundles
   regenerated where touched, commits per repo with explicit pathspecs.

## Risks

- Editing a live run's workflow source corrupts the run: cancel
  ddd-quality-loop / ddd-test-coverage runs before touching their files.
- multi's working tree previously raced concurrent agents; commit with
  explicit pathspecs only.
- The iframe has an opaque origin in multi: no storage, no parent access.
  Anything needing persistence lives in the host page.
- Pair fails open without PAIR_KEYS; the collab bar must not weaken the
  Worker fences (single-table, single-room where clause).
- multi's smithers store currently refuses ps (sqlite -> pglite migration
  receipt with empty pg store); repair with `smithers migrate --from sqlite
  --to pglite` before exercising gateway flows there.
