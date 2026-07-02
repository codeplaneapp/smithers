# Docs Driven Development (DDD) — smithers-native rebuild

A port-and-rebuild of `../multi`'s `docs-driven-development` workflow + custom UI
into this repo, generalized so it maintains a living spec for the smithers
product itself. The original is the reference implementation
(`/Users/williamcory/multi/.smithers/{workflows,ui}` and
`scripts/docs-driven-development/`); this rebuild keeps its proven loop shape and
hard-won fixes while removing every multi-specific hardcode.

## What it is

A long-running improvement loop over a structured product spec:

- **Source of truth**: `.smithers/spec/features.json` — a zod-validated array of
  feature records (id, title, summary, status, priority, owner, tier, group,
  userValue, capabilities, endpoints, links, tests, observability, debug,
  architecture, evidence, changes, diffHints, missing).
- **Editable narrative**: `.smithers/spec/content/overview.md`.
- **Derived docs**: `.smithers/spec/content/features/<id>.md`, regenerated from
  features.json — never hand-edited.
- **Custom UI** (`smithers ui --workflow docs-driven-development`): five tabs —
  Features (grouped matrix + detail modal), Docs (Milkdown Crepe WYSIWYG editor
  over the content tree, edits dispatch a run with a metaTicket), Audit (round
  outputs), Live (runs list + run tree + event log + chat), Tickets (backlog +
  materialized triage tickets).
- **Workflow loop** per round: bootstrap (build gate) → metaTicket (capture
  docs-editor delta + git state) → audit (agent) → spec-update (agent edits
  features.json honestly) → triage (agent picks next work) → materialize-tickets
  (compute) → optional Approval → work:1 (agent) → cycle-review (agent) →
  round-summary (compute). Loop exits only when round-summary says done AND
  features.json corroborates (0 open features).

## Improvements over the multi version

1. **No hardcoded machine paths** — everything relative to the repo root
   (`process.cwd()` at workflow load); agents come from `.smithers/agents.ts`
   providers (no per-repo cwd pinning, so `<Worktree>` stays usable later).
2. **No product-specific helper commands** in prompts (`pnpm docs:*` is gone).
   One build entry: `bun .smithers/lib/ddd/build.ts` = validate → generate
   derived feature docs → regenerate UI content modules. Bounded audit inputs
   come from `bun .smithers/lib/ddd/audit-inputs.ts` (prints the file list an
   auditor may read) and `bun .smithers/lib/ddd/triage-candidates.ts --max N`
   (ranked open gaps from features.json).
3. **Kept hard-won fixes** (with their comments): `needs` remap on
   round-summary, maxRounds Number(null) bulletproofing, work-wave always
   materializing as a direct Task, featuresStillIncomplete() corroboration,
   never-edit-the-running-workflow rule in work prompts, bounded metaTicket
   fields with artifact spill.
4. **Lighter UI deps**: reuse the repo's existing `crepeTheme.generated.ts`;
   replace `@pierre/trees` with a small built-in tree list; mermaid preview is
   dropped for v1 (recorded as an open gap in the workflow's own feature entry).
5. **Ticket materialization stays a compute node** writing
   `.smithers/tickets/docs-driven-development--<run>--<slot>-<id>.md`.

## Generated-module contracts (UI ⇄ scripts)

`bun .smithers/lib/ddd/build.ts` writes, into `.smithers/ui/`:

- `ddd-docsContent.generated.ts` — `export const docsContent: { path: string; title: string; content: string }[]`
  (path is content-root-relative, e.g. `overview.md`, `features/<id>.md`) and
  `export type DocsContentEntry = (typeof docsContent)[number]`.
- `ddd-ticketsBacklog.generated.ts` — `export const ticketsBacklog: { path: string; kind: string; status: string; updatedAtMs: number; content: string }[]`,
  one ticket per open gap in features.json.
- `ddd-workflowSource.generated.ts` — `export const workflowSourcePath: string`
  and `export const workflowSource: string` (the workflow .tsx source, for the
  Audit tab's script card).

The UI also imports `features` directly from `../spec/features.json` and the
existing `./crepeTheme.generated`.

## Workflow contract

Same output schemas as multi (bootstrap, audit, spec, metaTicket, triage,
materializedTickets, work, review, summary) via `createSmithers`. Node ids the
UI binds to: `bootstrap`, `metaTicket`, `audit`, `spec-update`, `triage`,
`materialize-tickets`, `work:1`, `cycle-review`, `round-summary`.
Input: `maxAgents` (1..8, default 1), `maxRounds` (default 100000),
`runImplementation`, `requireImplementationApproval`, `implementationApproved`,
`useClaudeForPlanning`, optional `metaTicket` payload from the Docs editor.
Agent routing: codex = implementation default; claude (fable) = planning/review;
claudeSonnet = trivial bounded edits; when `useClaudeForPlanning=false` those
slots route to codex.

## Open gaps (v1)

- Mermaid diagram preview in the Docs tab.
- Image upload target: Crepe's ImageBlock upload needs an asset server; v1 wires
  `?assetBaseUrl` passthrough but ships no asset server (uploads disabled when
  absent).
- Only `work:1` (single-agent wave), matching multi's SQLite-fanout caution.
