# CLAUDE.md / AGENTS.md

Guidance for Claude Code (and any AI agent) working in this repository.
`AGENTS.md` is a symlink to this file, so both stay in sync — edit `CLAUDE.md`.

## What's in this repo (read first)

This repo is **smithers the tool** — the durable control plane itself, not a
product UI. **The main product UI is built in a SEPARATE repo, not here.** What
ships from this repo:

- **`packages/*`** — the published library and the core product: the engine,
  scheduler, driver, graph, db, gateway/server, agent adapters (`agents`),
  `smithers ui` render primitives (`components`, `gateway-react`,
  `gateway-client`), memory, scorers, openapi, time-travel, sandbox, vcs, etc.
- **`apps/cli`** — the `smithers` CLI (also the MCP server and local workflow
  tools). The `smithers` bin points here.
- **`apps/observability`** — concrete metrics/logging/tracing/OTLP integrations
  (exported as `smithers-orchestrator/observability`).
- **`.smithers/`** — the init workflow pack that `smithers init` installs:
  built-in workflows, their custom `smithers ui` UIs (`.smithers/ui/*.tsx`),
  components, evals, and skills.
- **`apps/review`** — backs the built-in `open-code-review` workflow.
- **`docs/`, `skills/`, `e2e/`** — human + agent docs (incl. the generated
  `llms-*.txt` bundles), the skills, and the no-mocks end-to-end suite.

The custom UIs that matter in *this* repo are the ones you build with
**`smithers ui`** — workflow UIs under `.smithers/ui/*.tsx`, rendered via
`packages/gateway-react` + `packages/components`. When docs or work mention "the
UI", it means this `smithers ui` surface, **not** a product web app.

**POCs / demos — NOT the product. Do not do product work here and do not cite
their tech or patterns as current:** `apps/smithers` (chat-first Cerebras PWA
POC), `apps/smithers-studio-2` (studio shell POC), `apps/smithers-demo`,
`apps/smithers-tui-demo`, and `~/gui` (Swift/AppKit). `../plue` (smithers cloud)
is a separate repo. Ignore all of these unless explicitly asked.

## Source control: this is a jj (Jujutsu) colocated repo

There is a `.jj/` **and** a `.git/`. `jj` owns the working copy; raw `git`
(and `gh`, CI, hooks) still works — plain `git add`/`commit`/`pull --rebase`/
`push` is a fine way to land a change here — but when jj and git disagree,
**trust `jj`**.

- **Diagnose with `jj st` / `jj log`, not `git status`.** In colocated mode the
  git `HEAD` trails the jj working copy, so a git-only diagnosis lies. A stuck
  working-copy snapshot can show **phantom `D` deletions** of files that are
  still on disk (and `jj new`/`abandon`/`restore` won't clear it). Recover with
  `rm <path> && git checkout HEAD -- <dir>`. Switching the colocated git branch
  (`git checkout main` when `main` is at the same commit) also resets the index
  back to `HEAD`, which clears such phantom entries.
- **Commit with explicit pathspecs** (`git commit <path>` or staged `jj`
  ranges), never a blanket `git add -A`. This working tree is shared with
  concurrent agents; a racing catch-all `git add` corrupts the index (duplicate
  tree entries → GitHub fsck rejects the push). It also keeps phantom deletions
  out of real commits.

## Branching & commits

- **Always work directly on `main`** (the `main` bookmark in jj). Do not create
  feature branches unless the user *explicitly* asks you to. Commit and push to
  `main`.
- **Atomic commits.** One logical change per commit — a feature and its test can
  go together, but unrelated changes get separate commits. Never bundle
  unrelated work into one commit.
- **Emoji + Conventional Commits.** Every commit message starts with an emoji,
  then a conventional-commit subject. Examples:
  - `✨ feat(cli): add \`smithers ui\` command`
  - `🐛 fix(gateway-react): live-run events for detached runs`
  - `✅ test(server): gateway shared-DB run attribution`
  - `♻️ refactor(engine): batch live-event frame application`
  - `🔒 fix(gateway): reject cross-origin PTY upgrades`
  - `📝 docs: …`  ·  `🔧 chore: …`  ·  `🙈 chore: gitignore …`
- End commit messages with the `Co-Authored-By` trailer when authored by an agent.
- Push to `origin` (`github.com/smithersai/smithers`) `main` unless told otherwise.

## Verify before you push

`main` is shared. Before committing/pushing, keep the gate green (this mirrors
CI in `.github/workflows/ci.yml`):

- `pnpm typecheck` (root `tsc --noEmit`).
- `pnpm test` — runs the gate checks (`check-single-effect-version`,
  `check-dependency-boundaries`, `check-docs`, `check-llms`) then `pnpm -r test`
  (each package/app's `bun test`). Run a single package with
  `pnpm -C packages/<pkg> test`.
- `pnpm -C e2e test` for the real-backend end-to-end suite (`e2e/`); fault cases
  via `pnpm -C e2e test:faults`.
- If you touched `docs/`, regenerate the LLM bundles with `pnpm docs:llms`
  (CI gates on `check-docs` / `check-llms`).

CI runs on a clean box with **no agent CLIs and no browsers** — tests must seed a
fake agent and skip browser-only e2e, or they go red in CI while green locally.

## No mocks

Product code and e2e tests must use real backends/data — no `mockGateway`, no
`page.route`/`routeWebSocket` data fabrication, no hardcoded/fallback stand-ins.
Fixtures may be real servers seeded with deterministic data; deliberate
failure-injection against a real fault path is acceptable (see `e2e/faults/*`).
An e2e test that mocks the thing it claims to exercise is not an e2e test.

<!-- smithers:prefer-workflows START -->
## Smithers workflows

Use your best judgment, weighing speed, quality, and token usage, to decide
whether a request should run as a [smithers.sh](https://smithers.sh) workflow
or with regular subagents. Prefer a smithers workflow for multi-step plans and
for work that benefits from retries, approvals, review, or replay; reach for
plain subagents when a request is a quick one-off.

The `smithers` skill is installed: run `smithers workflow list` to see the
available workflows and `smithers workflow run <id>` to launch one.

When a session ends successfully and the work could have been a smithers
workflow, offer to turn the session into a reusable smithers workflow for next
time.
<!-- smithers:prefer-workflows END -->
