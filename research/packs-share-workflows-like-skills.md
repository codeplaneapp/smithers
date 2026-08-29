# Plan: "Share workflows like skills" — packs + messaging launch

> **Written for Smithers 0.x.** This note is research from before the 1.0
> rewrite. It describes the JSX workflow runtime, its CLI, or its gateway, none
> of which exist in 1.0.0-rc.0. It is kept as history, not as guidance; see
> `docs/pages/migration/1.0.md` for what replaced each surface it names.

Status: **design approved in principle, pending final review** (will, 2026-07-13).
Scope: one combined launch — ship `smithers add` + packs first, then flip the README/homepage
messaging with the install one-liner as the hero moment.

## Positioning

Hero line: **"Share workflows like skills."**

The argument: AI harnesses made skills portable, and skills became an ecosystem because of
it. Smithers does the same for the rest of the agent stack — workflows and their UIs. The
framing spectrum (used once each in README + homepage, generic community framing, no real
people's likenesses):

> UI monolith ("use the one official UI") ↔ **UI ecosystem ("use this cool UI I found")** ↔
> disposable UIs ("just make your own")
>
> Smithers claims the middle. Same for workflows.

The payoff demo (README section + homepage Portable guarantee both end on it):

```bash
smithers add someuser/kanban-suite
smithers workflow run kanban --prompt "triage my issues"
```

## Decisions (locked 2026-07-13)

| Decision | Choice |
| --- | --- |
| Manifest | `smithers.toon` at the root of any `.smithers`-shaped dir (TOON format; `@toon-format/toon` already in the stack) |
| Universal manifest | Yes — `smithers init` scaffolds `smithers.toon` into every `.smithers/`; **every .smithers is a publishable pack** |
| Install location | `.smithers/packs/<name>/` (local, default) and `~/.smithers/packs/<name>/` (`-g`), mirroring workflow tiers |
| Pack deps | Host-provided only for v1: `smthrs`, `react`, `zod` — enforced at add-time by import scan |
| Edit model | Read-only + `smithers eject <pack>:<workflow>` copies into local `.smithers/` where shadow order makes it win |
| v1 pack contents | workflows + UIs + prompts/lib (skills/evals in v2) |
| Discovery | awesome-smithers is the v1 registry (new Packs section with install one-liners); no hosted registry yet |
| Naming | noun **packs**, verb **`smithers add`** (`install` alias) |
| share-pack | Seeded `share-pack` workflow ships in the launch |
| Launch shape | Combined: land the feature, then the messaging leads with the working command |

## Track B — feature spec

### `smithers.toon` manifest

```toon
name: kanban-suite
version: 0.3.0
description: Kanban-style ticket fleet workflows with a live board UI
repository: github.com/someuser/kanban-suite
smithers: ">=0.28"          # engine compat range
contents:
  workflows[2]: kanban,ticket-fleet
  ui[1]: kanban
capabilities:
  bins[1]: git
  env[0]:
  writes: repo               # repo | sandbox | none
```

- In a project: `.smithers/smithers.toon`. In a published pack repo: repo root (or the
  subdir a spec points at). Same file, same schema.
- `smithers init` (and the durable `init` system workflow's install-pack stage) scaffolds it
  with defaults derived from the project; re-init reports drift like other pack files.
- Install-time trust report renders from `capabilities` + existing per-workflow frontmatter
  (`evaluateEligibility` in `apps/cli/src/workflows.js`).

### Spec syntax & fetch

- `smithers add user/repo` — bare GitHub shorthand (npm-style)
- `smithers add github:user/repo[/subdir][#ref]` — codeload tarball fetch (revives the
  mechanism removed in 0.20.2, now for packs)
- `smithers add npm:pkg[@version]` / `smithers add pkg@1.2.0` — npm registry tarball fetch + extract
- `-g/--global` targets `~/.smithers/packs/`; default is the nearest `.smithers/packs/`
- `--yes` skips the trust confirmation

### Lifecycle commands

- `smithers add <spec>` — fetch, validate manifest, scan imports, show trust report,
  extract, write lock entry
- `smithers remove <name>`, `smithers packs update [name]` (re-resolve per lock
  spec; bare form updates every locked pack), `smithers packs list`. Pack updates
  live under `packs update` because bare `smithers update` already means "upgrade
  the Smithers install itself" — overloading it was a collision found during
  implementation (2026-07-13).
- `smithers eject <pack>:<workflow>` — copy workflow + UI + referenced prompts/lib into
  local `.smithers/`; `update` never touches ejected copies
- `smithers share` — uses the `gh` CLI to fork/clone awesome-smithers, add/update this
  pack's entry in its Packs section (name, description, install one-liner from
  `smithers.toon`, plus one line per workflow from frontmatter), and open the PR.
  Flags: `--repo` override, `--dry-run`. The `share-pack` workflow calls it as its
  final step. (Added 2026-07-13 per will.)
- Lockfile: `packs.lock.toon` beside each packs dir (spec → resolved commit/version/integrity)
- Durable path: an `add` **system workflow** (`system: true`) like `init`; the imperative
  CLI command bootstraps it (repo convention for internal durable processes)

### Discovery changes

`resolveWorkflowDirs` (`apps/cli/src/workflows.js:547`) gains two tiers:

env paths → curated → local `.smithers/workflows` → **local packs** (`.smithers/packs/*/workflows/`)
→ global `~/.smithers/workflows` → **global packs**

- Local workflows always shadow pack workflows on id collision; `workflow run <pack>:<id>`
  disambiguates explicitly
- `workflow list` gains a source column (`local` / `pack:<name>` / `global`)
- Both flat `<id>.tsx` and directory-form `<id>/workflow.tsx` inside a pack's `workflows/`

### UIs

`<UI entry>` already resolves relative to the workflow's entryFile
(`packages/server/src/gateway.js` `resolveWorkflowEntryRef`), so `packs/<name>/ui/<id>.tsx`
referenced as `../ui/<id>.tsx` works with the existing Gateway Bun bundler. The
self-containment rule (no imports escaping the pack) applies per-pack; enforced by the same
add-time import scan.

### Dep restriction enforcement

At add-time, scan all pack TS/TSX for bare imports; allowlist `smthrs`,
`@smthrs/*` (ui/gateway-react/gateway-client), `react`, `zod`. Anything else →
hard fail with a clear message naming the file and import. (Runtime would fail anyway;
failing at add is the feature.)

### share-pack seeded workflow

New seeded workflow (added to `SEEDED_WORKFLOW_IDS` in `scripts/generate-workflow-pack.ts`,
with its own `.smithers/ui/share-pack.tsx`): agent validates/completes `smithers.toon`,
strips private files (`smithers.db*`, `runs/`, `logs/`, `node_modules/`, `state/`, agent
configs), scaffolds a README from the manifest, creates the GitHub repo, pushes, and opens
the awesome-smithers PR. Completes the loop: create → run → **share**.

### Tests / gates

- CLI unit tests: spec parsing, tarball extraction, manifest validation, import scan,
  lockfile round-trip, eject shadowing, `-g` scoping
- e2e (real backends, no mocks per repo rule): `add` from a local fixture repo served over
  git/file transport → `workflow list` shows the pack tier → `workflow run <pack>:<id>`
  executes → `eject` → local copy shadows → `update` leaves ejected copy alone
- `check-docs`/`check-llms` after Track A; regenerate seeded pack
  (`bun scripts/generate-workflow-pack.ts`) after share-pack lands

## Track A — messaging

### README.md

- New top-level section after "Why not just let my agent orchestrate itself?":
  **"Share workflows like skills"** — the skills analogy, the spectrum framing, the
  two-line `smithers add` demo, `share-pack` mention, awesome-smithers CTA ("add yours")
- New bullet in "What you get": 📦 **Portable workflows and UIs** — a workflow is a
  shareable directory with its UI, not a session artifact; install someone else's with one
  command
- Cleanup while in there: the orphaned one-row primitives table (`<Loop>` only) at
  README.md:107

### Homepage (`docs/index.mdx`)

- Guarantees row becomes four: Durable / Composable / **Portable** / Self-improving.
  Portable copy: "A workflow is a directory. Its UI travels with it.
  `smithers add user/repo` installs someone else's."
- Short spectrum-framing section near "Already fanning out subagents?" (same rhetorical
  slot: positioning against alternatives)
- Hero subhead gains one clause on sharing; keep time travel as the killer feature

### Docs

- New guide **"Share a pack"** grown out of `docs/workflows/catalog.mdx`'s existing
  "Marketplace Metadata" + "Publishing Checklist" and
  `docs/integrations/ecosystem.mdx`'s "Publishing Workflow Packs": manifest schema, pack
  layout, `share-pack`, awesome-smithers listing
- New reference page for `smithers add` / `remove` / `update` / `eject` / `packs list`
  (+ CLI overview catalog entry — remember the check-docs gate covers new CLI flags)
- `docs/integrations/custom-ui.mdx`: short "Share a UI" note (UIs ship inside packs)
- Regenerate: `pnpm docs:llms`; gates `check-docs` / `check-llms`

### awesome-smithers

- New **Packs** section: table of name / description / `smithers add` one-liner; seed it
  with 2–3 first-party packs extracted from `examples/init-pack/` so the section isn't
  empty at launch

## Sequencing

1. Manifest + init scaffolding (`smithers.toon`) — smallest standalone landable piece
2. `smithers add`/`remove`/`update`/`packs list` + discovery tiers + lockfile + trust report
3. `eject` + shadow semantics
4. `add` system workflow + `share-pack` seeded workflow (+ its UI) + pack regen
5. Seed 2–3 first-party packs; awesome-smithers Packs section
6. Track A messaging (README, homepage, docs, llms regen) — lands last, everything in it true
7. Launch content (release notes / `release-content` workflow)

## Defaults assumed unless overridden

- `smithers install` kept as a hidden alias of `add`
- Pack name comes from manifest `name`; spec-derived fallback (`user-repo`) when absent
- npm installs resolve dist-tags like npm (`@latest` default)
- Global packs are visible to every workspace's gateway/`workflow list`, exactly like
  global workflows
- v2 backlog (not in this launch): pack-shipped skills/evals, full per-pack npm deps,
  hosted registry / `smithers search`, `smithers publish` to npm
