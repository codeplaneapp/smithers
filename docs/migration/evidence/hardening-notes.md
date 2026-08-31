# Phase 7 hardening notes (carried forward, not gates)

- ServerSoak determinism (packages/sync): classified environmental at
  rc.0. If determinism is wanted later: probe `process.execArgv` inside
  the suite first, then set --expose-gc by whatever mechanism the
  installed vitest honors — poolOptions.forks.execArgv did NOT reach the
  worker (proven 2026-08-29, patch dropped by its own throw-if-missing
  guard; details in patches/parity-integration-report.md, "Sync
  expose-gc patch dropped" section). Zero ship value while the suite
  passes environmentally; do not block any gate on it.

- Workflow authoring discipline (process note, not a gate): three
  same-class script defects were caught during this program — a verify
  loop capped at N rounds combined with an UNGATED downstream stage
  (migration-tool merge; phase4 merge; both fixed pre-bite). Rule: any
  stage consuming a verify loop's output must condition on verdict.pass,
  and a final failing round must HOLD, never fall through. Encode this
  in future workflow templates.

- Shared-repository worktree hazard (process note): parallel lanes on
  worktrees of ONE repository share the stash stack and refs. The
  integrations lane's `git stash pop` applied an unrelated lane's stash
  (recovered via reset --hard; entry preserved). Rule for future lane
  prompts: never use `git stash` in a shared-repo worktree; use a
  scratch commit or `git worktree`-local branches instead. Also: a lane
  agent killed mid-write leaves uncommitted residue that the resumed
  agent must review explicitly (dual-lockfile invariant check).
- sameHostPidProbe: SHIPPED at rc.0 and wired as the Node host DEFAULT liveness check composed over the lease (run-store Ownership.ts; cancel-durability proved the same-host mutual-steal it prevents). Release notes state that shape (enforcement ruling 4 amended, 2026-08-29).
- Class rule (from N-06, retry-park-resume): engine failures never
  travel through the domain error schema; the run driver settles engine
  errors via a schema-agnostic envelope. Memory-engine passes are not
  evidence for durable settlement — every settlement test runs on real
  SQLite. Sweep item: grep for orDie/validate-against-errorSchema on
  engine-originated failures.
- Verification doctrine (process note, from Phase 4/5): the lanes that
  read safest on a pre-read (providers-hosts, bridge, integrations)
  failed worst on the red-check overlay — hand-written SDK slices,
  policy lowered into a bag nothing reads, clients without bindings,
  smokes that pass on total refusal. The red-check overlay (pre-fix
  clone + overlaid pin tests proven red at the pinning assertion) is
  MANDATORY for every fix-round verdict, and a report claim of "wired"
  or "lowered" needs a test that fails when the wiring is removed.
- Sweep item HARDEN-2: validate every staged capability literal tree-wide through the real Capability.parse (three instances of the resource-literal class this program).

- HARDEN-1 instance 4 (containment r2): guarded-spawn gates were regexes and passed a multi-line import of node:child_process; ruled AST-based. Class count now four.
- apps-deploy.yml has no repository guard (tags + workflow_dispatch;
  real deploy when CLOUDFLARE_API_TOKEN is set): a tag push from a fork
  or the wrong repo deploys to the flows-owned Worker. Add
  `if: github.repository == 'smithersai/smithers'`-equivalent via the
  generator (no raw if: keys in generated ci) before any tag is pushed.
- CI's //apps/review skips both live-GitHub suites without GH_TOKEN:
  set `GH_TOKEN: ${{ github.token }}` on that job or record the skip as
  ENV-SKIP in the Phase 7 evidence; pr-review.yml's live run is
  post-main only.
- Sync fan-out hardening: add a maxPagesPerRound cap so a hot run tail yields its slot within a round (rc.0 posture: 1 s cross-process freshness, one page per open read).
- H-1 (retained-apps): resolve the gh binary ONCE to an absolute path at preflight and reuse it (ghBin() returns a bare name; per-spawn PATH/cwd resolution under the checked-out PR is a relative-PATH exposure).

- Plugins repository (~/smithers-plugins, branch phase4/providers-hosts, HEAD 5af8e8c at 2026-08-29 16:10): separate deliverable, clean, NOT pushed; needs its own review + push; dev resolution via pnpm-workspace.yaml overrides against ../smithers-v1 (documented; nothing ships link:). Phase 7 checklist item.

- Process rule: never rebase a lane branch after another lane has merged it (bridge rebase onto a7626e75af re-hashed commits that examples/cli-ops carried; caused divergent-history conflicts).
