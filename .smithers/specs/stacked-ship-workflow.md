# Stacked Ship: non-blocking PR-stack delivery as a Smithers workflow

Stacked Ship (`.smithers/workflows/stacked-ship.tsx`) builds a large mission end to
end as a stack of clean PRs with human review in the loop, without ever letting
review block the build. It is the successor to the review workflow for missions the
human actually reads: every PR gets a story-form HTML artifact, approvals are async
marks rather than gates, and review feedback triggers in-place rebases of the
commit it targets while work continues above it.

Its first mission is building Smithers Studio per
`.smithers/specs/smithers-studio-local-app.md`. The mission is input, not
hardcode: any spec with a PR plan can ride the same workflow.

## The process contract

- **Stacks, not branches.** The unit of work is a linear jj stack. PR N sits on
  PR N-1. There are no long-lived feature branches, no merge commits.
- **One change per PR, forever.** A PR is exactly one jj change, amended in place
  for its whole life. Rework never appends fixup commits; it amends the change and
  jj auto-rebases every descendant. History is always clean by construction, not
  by a cleanup pass.
- **Approvals are async marks.** An approval records the human's verdict on a PR
  revision. Nothing downstream waits for it except the final push. Lanes above
  keep building against the unapproved PR.
- **Reviews trigger rebases.** A denial carries a note; the note becomes the
  rework prompt; the rework amends the PR's change; descendants restack
  automatically; the artifact regenerates; a fresh approval request goes out for
  the new revision.
- **Every PR ships a story.** A self-contained HTML artifact per PR revision:
  headline, synopsis, chapters that interleave prose with readable diffs, plus the
  mechanical facts (files, tests run, hygiene verdict). The reviewer reads the
  artifact, not raw patches.

## VCS mechanics

All stack state lives in a private clone so nothing races the shared checkout:

- Setup creates `.smithers/workflows/.worktrees/stacked-ship-<runKey>/repo`:
  `git clone` from the launch root (local objects, fast), `git remote set-url
  origin <the root's origin URL>`, `jj git init --colocate`, `pnpm install`.
- Lane N gets its own jj workspace `pr-<slug>` inside the clone (`jj workspace
  add` with the lock-retry pattern), with its working-copy change created on top
  of lane N-1's change (on top of the base for lane 1) and bookmark
  `stack/<runKey>/<slug>` pointing at it.
- Because lane N+1's change is a jj child of lane N's change, amending lane N
  restacks every lane above it with no explicit rebase. Conflicts materialize as
  jj conflict markers in descendants and fail the hygiene gate of the lane that
  owns them.
- The stack never touches origin until the push step, which pushes bookmarks as
  branches (`jj git push --bookmark`) and never pushes main.

## Clean-commit hygiene gate (mechanical, per revision)

A compute task, pure logic in `.smithers/lib/stackedShip.ts`, executed against the
lane workspace:

1. Exactly one change between the parent bookmark and the lane bookmark.
2. The change description matches the repo commit style
   (`<emoji> <type>(<scope>): <subject>`).
3. The diff against the parent is non-empty and every touched path matches the
   lane's allowed scopes from the plan.
4. No conflicted changes among the bookmark's descendants.
5. The lane's scoped check commands (tests, typecheck) exit zero.

Failures produce structured feedback that feeds the next implement iteration.

## Workflow shape

Node ids are stable and content-keyed (`<slug>:implement`, never index-keyed).
Output tables are prefixed `stship*` to keep the shared workspace DB collision
free. Reserved column names (runId, nodeId, iteration, id) are never used in
schemas; the run key travels as `stackKey`.

```
setup (compute)                      # clone + jj init + install
plan (agent: fable)                  # spec -> PR plan JSON (slugs, scopes, checks)
for each planned PR, gated on the previous lane's bookmark existing:
  <slug>:workspace (compute)         # jj workspace + change + bookmark
  Loop <slug>:build (until hygiene green + self-review approve, max N):
    <slug>:implement (agent: codex sol chain)   # amend the change
    <slug>:hygiene (compute)                    # the gate above
    <slug>:self-review (agent: opus chain)      # diff review, approve/reject
  Loop <slug>:review (until human approves, max M, onMaxReached return-last):
    <slug>:story (agent: sonnet)                # story JSON for this revision
    <slug>:artifact (compute)                   # render HTML artifact
    <slug>:approval (Approval async, onDeny continue)
    <slug>:rework (agent, only mounts when latest decision is a denial)
    <slug>:rework-hygiene (compute, after rework)
assemble (compute, after all lanes settle)      # full stack gates at the tip
final-review (agent: fable)                     # whole-stack pass, may polish
push (compute, gated: input.push AND gates green AND approvals approved)
summary (compute)                               # terminal roll-up
```

Lane starts are serialized (lane N mounts once lane N-1's workspace row exists and
its first hygiene pass is green) but lanes overlap freely after that; a lane in
rework never blocks lanes above it from progressing, and pending approvals never
block anything except push.

The run parks as waiting-approval whenever approvals are the only outstanding
work. That is the designed resting state: build done, reviews pending, resumable
forever.

## Artifacts

`.smithers/lib/stackArtifact.tsx` renders one self-contained HTML file per PR
revision to `.smithers/reports/stacked-ship/<runKey>/<slug>-r<iteration>.html`
plus a stack index at `.../index.html`. Renderer contract:

- React `renderToStaticMarkup` with `<SmithersUiStyles withTheme />` from
  `smithers-orchestrator/ui`; document shell, theme boot script, and keyboard nav
  follow the walkthrough precedent in `apps/review`.
- Diffs render through the pierre SSR path (`@smithers-orchestrator/review/diffs`:
  `renderPierreFileDiff` + `extractDiffAssets`, bodies wrapped in `.pierre-diff`),
  falling back to SSR `DiffHunks` over `parseUnifiedFile` for oversized or failed
  files. Both dependencies already exist in `.smithers/package.json`.
- Static output means no Radix interactivity: collapse is `<details>`, navigation
  is anchors plus the small inline script.
- The story schema is `{ headline, synopsis, chapters: [{ title, prose,
  diffPaths }] }`, validated and repaired deterministically; a fallback story is
  generated from the diff stat when the story agent fails, so the artifact always
  exists.

## Approval protocol

Each `<slug>:approval` is `<Approval async onDeny="continue">` with the artifact
path and story headline in the request summary. The operating agent (or the
custom UI) relays it; decisions resolve via `smithers approve/deny`. Approve ends
the lane's review loop. Deny with a note starts a rework iteration; the note is
injected verbatim into the rework prompt. Iterations of the review loop mint
fresh approval requests keyed by iteration, so every revision gets its own
verdict trail.

## Live UI

`.smithers/ui/stacked-ship.tsx` composes gateway-ui and ui components (never
hand-rolled markup): a stack ladder of PR cards (StatusPill per lane phase,
hygiene verdict, approval state, artifact path, story headline), the
ApprovalPanel, and tabs for RunTree/NodeOutputView and RunEventLog, following the
review UI structure (exported pure helpers, guarded mount, `?runId=` deep link).

## Testing plan (near-total coverage)

Four layers over `smithers-orchestrator/testing`, mirroring the strongest existing
suites:

1. **Lib units.** Every pure function in `stackedShip.ts` and
   `stackArtifact.tsx`: plan validation, naming, hygiene verdict derivation from
   command transcripts, restack/conflict classification, story
   normalization/fallback, HTML rendering needles (styles present, diff bodies
   wrapped, details blocks, index links). Real jj repos in temp dirs exercise the
   jj-facing helpers (packages/vcs tests prove the pattern).
2. **Graph structure.** `renderWorkflow` with staged `outputs`: lane gating
   (nothing mounts before setup; lane 2 absent until lane 1's gate row exists),
   loop wiring, approval nodes carry async + onDeny continue + request title,
   rework mounts only on denial, push mounts only when gated true.
3. **Prompts.** `renderPrompt` needles: the spec path reaches the planner, the
   hygiene failure reaches implement, the denial note reaches rework, scope
   allowlists reach every implementer.
4. **Simulation.** `simulate` with `fakeAgent` scripts and computed-task mocks:
   the happy path (plan of 2 PRs, both lanes green, approvals approved, push
   mocked), the deny-then-rework-then-approve path, the never-approved path
   (run completes lanes and parks with return-last), hygiene-red retry path, and
   `unusedMocks` asserted empty.

Ownership registration is part of done: `stacked-ship` (workflow, UI, libs) gets
an owner suite in `workflow-component-inventory.test.ts` and the suite joins the
`.smithers/package.json` test script so `check-smithers-test-script.mjs` stays
green. Local caveat: `bun test` output is invisible on this machine; exit codes
and out-of-band `bun -e` probes are the verification signal.
