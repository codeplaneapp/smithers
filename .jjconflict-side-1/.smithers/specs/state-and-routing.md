# State and routing

How `apps/smithers` holds state. One rule decides where a value lives, and one
library is the interface for reading and writing it.

## The rule

**Zustand is the only state interface. Memory, `localStorage`, and the URL are
three storage media behind it.** A component never calls a router hook, a
`localStorage` key, or `useState`. It calls `useSomeStore()` and dispatches an
action. The medium a value uses is a property of its store, not something a
component knows.

This codebase also forbids `useState` and `useEffect`/`useLayoutEffect`
entirely. Everything those would do has a home:

| Effect job | Where it goes instead |
| --- | --- |
| persistence | a store on the `local` medium (zustand `persist`) |
| timers (engine tick, clock) | a module-level interval inside a store, started lazily |
| DOM sync (`data-theme`, scroll) | inside the store action, or a module-load `store.subscribe` |
| outside-click to close | a backdrop element, not a document listener |
| focus / auto-scroll | a ref callback that registers the node into a store |
| per-instance open flags | one global `openMenuId` in the UI store |

## The three media

Every slice declares one medium. The interface is identical; only the backing
differs.

- **ephemeral** — a plain store. Lost on reload. Chat text, run state,
  notifications, transient UI flags.
- **local** — `persist` middleware to `localStorage`. Survives reload, scoped to
  the device. Theme, layout, rail width, installed workflows.
- **url** — backed by the router. Shareable, deep-linkable, Back/Forward
  navigable. The active page, the focused run/diff, the selected project.

The `url` medium is the only one with a subtlety, and it stays a one-way flow
with no loop:

```
action (goToView / openSurface / setProject)
  -> router.navigate(...)        // the only writer of the URL
  -> router resolves
  -> router.subscribe(onResolved)
  -> useRouteStore.setState(...) // the only writer of the route slice
  -> components re-render
```

Actions never write the route slice directly. The subscription is its sole
writer, so a deep link, a Back button, and a programmatic `navigate` all land on
the same path. The earlier rule still holds underneath: **the URL holds the
pointer, the store holds the thing.** `/runs/4821` carries the id; the run
object lives in `runsStore` keyed by that id.

## Routing

Code-based routes, each colocated with its feature. A route's `component` is a
**page**; pages are distinct from reusable components and never live in
`components/`. The root route renders the shell chrome (composer, transcript,
toasts, layout frame) and an `<Outlet/>`; each page renders only its canvas.

```
/                          homeRoute        hero / chat transcript
/askme                     askMeRoute       grill-me graph
/store                     storeRoute       workflow store
/runs/$runId               runInspectorRoute   run inspector
/runs/$runId/logs          runLogsRoute        transcript surface
/runs/$runId/diff/$diffId  runDiffRoute        diff review
/runs/$runId/timeline      runTimelineRoute    time-travel
```

`project` is a root search param validated by `validateSearch` and held across
every navigation by `retainSearchParams`. It is a `url`-medium slice of the
route store; `setProject` calls `navigate({ search })` and the value returns
through the subscription.

The `Surface` union (`inspector` | `logs` | `diff` | `timeline`) is a one-to-one
image of the run routes. `openSurface(surface)` is a thin `navigate`, so the
existing card components that call it keep working unchanged.

## Electrobun

The only platform-sensitive piece is history creation, abstracted in
`app/history.ts`: a browser history on the web (deep links already work, the
Worker serves the SPA shell and the service worker is deep-link aware), and a
hash history under Electrobun, where the webview loads over a custom scheme with
no server routes. `localStorage` and the History API both work inside the
Electrobun webview, so `persist` and `url` slices need no per-platform branch.
Nothing downstream of `appHistory` knows which target it runs on.

## Stores

| Store | Medium | Holds |
| --- | --- | --- |
| `routeStore` | url | active view, focused surface, run/diff ids, project |
| `preferencesStore` | local | theme, layout |
| `railStore` | local | rail width, collapsed |
| `workflowsStore` | local | installed workflow ids |
| `chatStore` | ephemeral | composer text, messages, pending/streaming |
| `notificationsStore` | ephemeral | corner toasts (self-dismissing via timers) |
| `runsStore` | ephemeral | runs, the engine tick, approvals |
| `uiStore` | ephemeral | `openMenuId`, dictation `listening`, nav direction |

The run engine bridges to chat through `watchApprovals` (a module-load
`store.subscribe`), not an effect: it posts the approval card when a run hits the
gate and marks the toast done when the gate resolves.
