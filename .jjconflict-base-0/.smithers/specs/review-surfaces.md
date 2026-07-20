# Review surfaces: issues, tickets, landings

Three feature surfaces ported from the Swift gui (`IssuesView`, `TicketsView`,
`LandingsView`): a bug/feature tracker, a markdown ticket editor, and a stacked
PR (jjhub "landing") review queue. They are mock UI. The PWA has no gateway yet,
so each is seeded with believable demo data the same way the other feature cards
are, and mutations replay as a chat line plus a toast instead of hitting a
backend.

## The shape

Each feature follows the `vcs` feature as its template, one directory per
feature, colocated by domain:

| File | Role |
| --- | --- |
| `issues.ts` / `tickets.ts` / `landings.ts` | Domain module: types, seed data, and the pure immutable functions (filters, summaries, reducers, parsers). No DOM, no store. Unit-tested in the sibling `*Domain.test.ts`. |
| `*Store.ts` | A zustand store holding the seeded list plus all view state (selection, filter, tab, drafts) and the mutation actions. |
| `*Card.tsx` | The inline card posted into the chat transcript. Counts plus the first few rows, with a link that opens the canvas. |
| `*Canvas.tsx` | The full surface: a list rail on the left, a detail pane on the right. |
| `run*Route.tsx` | The route, a top-level surface (`/issues`, `/tickets`, `/landings`). |

`LandingDiff.tsx` renders a landing's unified diff with the shared `.diff`
classes; `parseDiffLines` in `landings.ts` does the signed-line split and is
unit-tested.

## State lives in the store

These features obey the app's state rule (see `state-and-routing.md`): no
`useState`, no `useEffect`. Selection, the active filter, the landings detail
tab, the editor buffer, and every create form field live in the feature store.
Components read selectors and dispatch actions. The selected entity is derived in
the component, `store(s => s.items.find(i => i.id === s.selectedId))`, so the URL
holds the pointer and the store holds the thing.

Mutations post feedback the way `vcsStore` does. Closing an issue, saving a
ticket, or approving a landing calls `useChatStore.say(...)` for a chat line and
`useNotificationsStore.notify(...)` for a transient toast.

## How a user reaches them

- Slash commands post the card into the transcript: `/issues` (or `/issue`),
  `/tickets` (`/ticket`), `/landings` (`/landing`). See `app/runSlash.ts`.
- The card's "Open ›" link calls `openSurface({ kind })`, which routes to the
  canvas. `app/deriveRoute.ts` maps the path back to the surface.
- The canvas is also deep-linkable: navigate straight to `/issues`, `/tickets`,
  or `/landings`.

`Card.ts` and `Surface.ts` carry the three new `kind`s; `CardView.tsx` fans the
card kind out to the component, and `router.ts` mounts the routes.

## Styling

The shared `.rev-*` vocabulary (list rail, detail pane, rows, create form,
editor, state badges) lives in one block in `cards/featureCards.css`, so the
three surfaces render alike. State color flows through the `--tone` tokens: a
`.state-badge` or `.rev-dot` carries a `tone-*` class and reads its color from
it.

## Tests

- Pure domain logic: `bun test src/{issues,tickets,landings}/*Domain.test.ts`.
- Real-backend e2e: `tests/e2e/reviewSurfaces.spec.ts` drives the live app with
  the seeded data (no route mocks), covering each card, its canvas link, and one
  store mutation per feature (close an issue, edit a ticket, approve a landing).
