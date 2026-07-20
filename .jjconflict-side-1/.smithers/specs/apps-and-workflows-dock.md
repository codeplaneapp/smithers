# Apps, workflows, and the dock

This is the model behind the right-edge app dock in `apps/smithers`. It pins down
two words that were doing too many jobs ("app" and "workflow") and describes the
taskbar that shows which apps are open.

## The one idea

A **workflow** is a verb. You launch it, it runs, it finishes.

An **app** is a noun. You open it, it stays, you come back to it.

If you remember nothing else: workflows are *launched* and produce runs; apps are
*opened* and live in the dock. A thing that completes is a workflow. A place you
go is an app.

### Workflow

The runnable graph primitive. It already exists in the app twice:

- the static browsable catalog in `src/store/workflows.ts` (`StoreWorkflow`), and
- live gateway workflows discovered over RPC (`GatewayWorkflow`).

Launching a workflow produces a *run*. A run shows up as the transient run
surfaces that already exist: `inspector`, `logs`, `diff`, `timeline`,
`gatewayRun`. Those are views of a running or finished workflow, not apps.

A running workflow does not get a dock icon. It announces itself through the
existing notification system (`useNotificationsStore`, `kind: "workflow"`), which
shows a toast that persists until the run is done and offers a "view" action.

### App

A domain workspace with identity (name, icon, accent color) and a home surface.
The git related app is today's `vcs` / "Changes" surface, renamed Git. The rest
of the domain surfaces are the same shape: a stateful view over one domain that
aggregates data and offers actions. The headline action of every app is "launch
one of my workflows," so the workflow primitive is common to all apps.

Apps are the existing domain surfaces, promoted to first-class objects:

| App id    | Name      | Opens (target)            |
|-----------|-----------|---------------------------|
| git       | Git       | surface `vcs`             |
| runs      | Runs      | surface `runs`            |
| issues    | Issues    | surface `issues`          |
| tickets   | Tickets   | surface `tickets`         |
| approvals | Approvals | surface `approvals`       |
| agents    | Agents    | surface `agents`          |
| memory    | Memory    | surface `memory`          |
| prompts   | Prompts   | surface `prompts`         |
| scores    | Scores    | surface `scores`          |
| crons     | Crons     | surface `crons`           |
| landings  | Landings  | surface `landings`        |
| store     | Store     | view `store`              |

Run surfaces (`inspector`, `logs`, `diff`, `timeline`, `gatewayRun`) and utility
surfaces (`workflowEditor`, `palette`) are deliberately not apps. They belong to
the workflow or the app that spawned them.

> Naming note: the workflow editor already labels a workflow's custom frontend
> its "App" tab (`doc.frontend`). That is a per-workflow UI, a different layer.
> "App" in this spec always means a top-level dock app; the per-workflow thing is
> its "custom UI."

## Apps and workflows are many-to-many

The link is one relation, read from both ends.

- From the app: the workflows it can launch (`App.workflowIds`). Git launches
  implement, review, debug, and so on.
- From the workflow: the apps it is attached to, derived by scanning the catalog
  (`appsForWorkflow`). Review attaches to Git, Approvals, and Landings.

For v1 the relation is a static catalog in `src/apps/appCatalog.ts`. Making it
user-editable is a follow-up.

## The dock

Open apps render as a horizontal row of icon tiles at the bottom of the screen,
macOS-style. The dock auto-hides: it sits just below the bottom edge and slides
up when the pointer reaches the bottom-edge trigger strip, or when a tile takes
keyboard focus (so it is reachable without a mouse). The chat-mode composer
floats above the trigger (`bottom: 18px`), so the trigger does not block it.

- The URL stays the source of truth for which app is **focused** (the canvas).
- A new store (`useDockStore`) holds the **set** of open apps and which one is
  active is derived from the route (`activeAppId`).
- Visiting an app (by card, slash, nav menu, or dock click) registers it in the
  dock. This is how the dock auto-populates.
- The open-app set is **persisted** (`localStorage`, `smithers.dock`), so the
  dock survives a reload.
- Clicking a tile focuses that app (navigates to its target). The active tile is
  highlighted.
- Each tile has a close affordance. Closing removes it from the dock; if it was
  the focused app, focus moves to the next open app, or home if none remain.
- Tiles whose id no longer resolves in the catalog are skipped, so a catalog
  change never strands a persisted id.

## Files

- `src/apps/App.ts` — `App`, `AppId`, `AppTarget` types.
- `src/apps/appCatalog.ts` — `APPS` registry, `getApp`, `activeAppId`,
  `workflowsForApp`, `appsForWorkflow`.
- `src/apps/dockStore.ts` — `useDockStore` (persisted open-app set).
- `src/apps/bindDock.ts` — subscribes the route store to register the active app.
- `src/apps/openApp.ts` — `openApp(id)`, maps a target to a navigation call.
- `src/apps/Dock.tsx` + `src/apps/dock.css` — the right-edge dock.
- Wiring: `bindDock()` in `main.tsx`, `<Dock />` in `AppShell.tsx`.

## Non-goals (follow-ups)

- User-editable app/workflow attachments and user-created apps.
- A per-app launcher panel listing the app's workflows (the data is ready via
  `workflowsForApp`; the UI is later).
- Running-run badges on dock tiles. Runs live in toasts for now.
- Drag-to-reorder dock tiles.
