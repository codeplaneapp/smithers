# smithers oneshot

Status: approved design, implementing 2026-07-21.
Driver feedback (Antonio Viggiano, 2026-07-21): "Smithers skills are triggered very
aggressively when sometimes a simple one shot by the agent would do it. Many times I
use gpt 5.6 xhigh sol to do something not very complex and it takes way more time to
build a Smithers workflow than to actually do what I said."

## Problem

Smithers workflows are a powerful way to get work done, but a lot of tasks can be done
more simply. Today the skill doctrine says "almost always create a workflow"
(skills/smithers/SKILL.md:233-264, :639-652), so orchestrating agents build a full
workflow for asks a single strong agent could just do. Authoring the workflow costs
more time than the task itself.

`smithers oneshot` is a built-in minimal workflow: one agent, one goal, launched
directly from the CLI with no workflow file on disk. It is fast to launch because
there is nothing to author, it runs in the background, and it gets a real run UI
(live chat log, pierre diff, hijack, pause/cancel). The orchestrating agent stays
lean: it never pulls the task's working context into its own window, and when it
needs to check on the work it reads the worker's chat transcript in a single tool
call (`smithers chat <runId>` or the `get_chat_transcript` MCP tool).

## UX contract

### CLI

```
smithers oneshot "<goal>" [flags]
```

- `<goal>` positional, required unless `--status` or `--set-review` is the whole
  invocation. Long goals may also come from `--goal-file <path>` (engine caps run
  input strings at 64KB; goal text above that must be a file).
- `--model <slot|id>`: `sol | terra | luna | kimi | fable | opus | sonnet` or a
  canonical model id. Default: auto chain (below).
- `--agent <engine>`: force an engine (`codex | kimi | claude-code | opencode`).
- `--review <on|off>`: override the stored review preference for this run.
- `--set-review <on|off>`: persist the review preference to global config (also
  sets `announced: true`). Usable with or without a goal.
- `--set-trivial <direct|oneshot>`: persist the trivial-ask preference (also sets
  `announced: true`). Usable with or without a goal.
- `--status`: print JSON: usable agents among {claude, codex, kimi, opencode},
  the resolved model chain, the stored preferences (`review`, `trivial`, null when
  unset), and `announced`. This is what an orchestrating agent calls before
  first use.
- `--cwd <dir>` (default `.`), like chat-create.
- `-d/--detach` default TRUE. Oneshot's story is "fast, but still happens in the
  background". `--detach false` runs foreground. The detach path spawns
  `bun <cli> oneshot ... --detach false` as its own unref'd child with a per-run
  log file, mirroring executeUpCommand's detach block (apps/cli/src/index.js:2269-2408)
  but re-invoking `oneshot`, not `up` (executeUpCommand's detach is file/ID-bound
  and cannot be reused as-is).
- `--interactive`: opt into the TUI monitor instead (mix in `interactiveRunOption`
  exactly like `up` does, apps/cli/src/index.js:1683-1687; never fold it into the
  shared options object).
- `--open <bool>` default true: after launch, open the oneshot run UI in the
  browser (same opener as `smithers ui`).
- On success prints runId + cta next steps: `ui <runId>`, `chat <runId>`,
  `hijack <runId>`, `pause <runId>`, `cancel <runId>`.

Availability gate: `smithers oneshot` is unavailable when none of the four CLIs
{claude, codex, kimi, opencode} is usable per `detectAvailableAgents()`
(apps/cli/src/agent-detection.js:820). Fail with a `NO_USABLE_AGENTS`-style error
reusing `formatNoUsableAgentsMessage` (:803). Other engines (antigravity, pi, amp)
do not count for the gate.

User override: if `.smithers/workflows/oneshot.tsx` exists in the workspace,
`smithers oneshot` runs THAT workflow instead of the built-in one (resolved the
same way `smithers workflow run oneshot` would), passing
`{ goal, review, model }` as input and keeping the same flags, detach behavior,
and UI open. The built-in in-memory workflow is only the default. The onboarding
announcement mentions this override. A user override also brings its own UI
resolution (`.smithers/ui/oneshot.tsx` by convention); the built-in UI is the
fallback when the override lacks one.

### Orchestrating-agent behavior (skill contract)

Three routing tiers, inferred from the prompt:

- Most trivial (a single change, doable in under ~10 agent turns: a typo, one
  small edit, a rename): by default the orchestrating agent does it DIRECTLY
  itself. No oneshot, no workflow, no delegation overhead. This default is a
  stored preference (`trivial`); if the user prefers `oneshot` for these, launch
  oneshot with a weaker model (opus or terra), never sol.
- Simple (one agent could finish it in under ~100k tokens of context with a
  single goal, but more than a most-trivial edit): route to `smithers oneshot`,
  not a workflow. Model preference: codex sol if usable, else kimi, else claude
  fable or opus. For the easy end of this band a weaker model (opus or terra)
  is fine.
- Complex (multi-stage, approval-gated, long-horizon, reusable): a real Smithers
  workflow, exactly as today. Oneshot is for the simple end only.

Rules on top of the tiers:

1. If the goal or its acceptance criteria are ambiguous, ask the user clarifying
   questions FIRST. Do not launch anything until the goal is crisp.
2. Infer complexity from the prompt by default, but honor explicit user
   overrides: "oneshot" forces oneshot routing, "oneshot with review" forces
   `--review on`, "oneshot without review" forces `--review off` for that run.
3. If `--status` reports no usable agent among the four, do not offer or attempt
   oneshot; fall back to normal routing.
4. Context hygiene: never read the oneshot task's diff or logs into your own
   window wholesale. Check progress with one call to `smithers chat <runId>`
   (or `get_chat_transcript`), and report the run UI URL to the user.

First use (per-user, tracked by `announced` in global config): before launching,
the agent tells the user about the feature, in substance:

> Smithers has a new feature: `smithers oneshot`. Smithers workflows are a
> powerful way to get work done, but a lot of tasks can be done more simply.
> Oneshot is a built-in minimal workflow that quickly and efficiently one-shots
> an ask with a single strong agent, in the background, with a live UI (chat log,
> diff of the changes, hijack, pause). There is nothing to author, so launching
> is fast. I will infer the complexity of each ask from the prompt, but you can
> always say "oneshot", "oneshot with review", or "oneshot without review"
> explicitly. If you ever want to customize what oneshot does, create
> `.smithers/workflows/oneshot.tsx` and smithers will run yours instead of the
> built-in.

and asks two preference questions, each with a stated recommendation:

1. Should oneshot runs add a round of review after implementing (higher quality,
   slower), or just implement? Recommended: add the review round.
2. For the most trivial asks (a single change I could do in a few turns), should
   I just do them directly myself, or still launch oneshot? Recommended: do them
   directly.

Both answers are saved in the global smithers config (via `--set-review` and
`--set-trivial`) and the agent says they can be changed anytime.

## Workflow construction (file-less)

New builder `apps/cli/src/oneshot/buildOneshotWorkflow.js`, a sibling of
`buildInlineChatWorkflow.js` (apps/cli/src/buildInlineChatWorkflow.js:84-145), the
only sanctioned file-less mechanism. Shared DB-opening logic should be extracted or
reused so `apps/cli/tests/db-encapsulation-boundary.test.js:9` needs at most one
allowlist addition. Same anchor-dir resolution and workspace `smithers.db` so
`ps`/`inspect`/`ui`/gateway all see the run. Non-sqlite backends: same guard as
buildInlineChatWorkflow (:119-121).

Shape, implement-only (`review off`):

```
<Workflow name="oneshot">
  <Task id="implement" output={oneshotResult} agent={chain}>{goalPrompt}</Task>
</Workflow>
```

With review (`review on`):

```
<Workflow name="oneshot">
  <Sequence>
    <Task id="implement" output={oneshotResult} agent={chain}>{goalPrompt}</Task>
    <Task id="review" output={oneshotReview} agent={reviewChain}>{reviewPrompt}</Task>
  </Sequence>
</Workflow>
```

- One review round only, no loop. The reviewer reviews the diff and directly fixes
  what it finds (review-and-polish, not a verdict loop). Oneshot stays fast.
- `oneshotResult` schema: `{ summary: z.string().min(20), filesChanged: z.array(z.string()) }`.
  `oneshotReview` schema: `{ summary: z.string().min(20), fixed: z.array(z.string()) }`.
  Value constraints are required so `{}` cannot pass validation (empty-repair trap).
  Table keys must be oneshot-prefixed (shared-by-name table collision trap) and must
  not use reserved column names (runId/nodeId/iteration/id/created_at).
- Do NOT set `hijack: true` on the tasks (that is chat-create's park-immediately
  chat semantics). Oneshot tasks run autonomously; hijack works after the fact via
  recorded attempt sessions (`hijackCandidatesFromAttempts`,
  packages/server/src/hijackCandidates.js:89). Verify a finished/running oneshot
  attempt actually surfaces as a hijack candidate; if CLI-agent session recording
  needs a flag to be candidate-eligible, wire it.
- The goal prompt wraps the user's goal with a short contract: do the work in cwd,
  keep the change minimal, report summary + filesChanged. No hand-rolled JSON
  instructions (the engine appends the schema contract itself).

## Model selection

Slots come from SOTA_SLOTS (apps/cli/src/sota-models.generated.js:12-26) so ids
track the registry:

- sol = `gpt-5.6-sol` (CodexAgent, reasoning xhigh), terra = `gpt-5.6-terra`,
  luna = `gpt-5.6-luna`, kimi = `kimi-k2.7-code` (KimiAgent), fable =
  `claude-fable-5` (ClaudeCodeAgent, or OpenCodeAgent as `anthropic/claude-fable-5`
  when only opencode is installed), opus = `claude-opus-4-8`, sonnet =
  `claude-sonnet-5`.
- Note: the ask referenced "kimi k3"; no such id exists in the registry. Use the
  SOTA kimi slot so oneshot picks up k3 automatically when the registry moves.

Default chain (no `--model`): ordered failover array over USABLE engines only,
`[codex sol, kimi, claude fable, claude opus]`, expressed as `agent={[...]}` so the
engine's preflight-aware chain selection (packages/engine/src/engine.js:4220-4300)
handles runtime failover for free. Respect `codexPaused()` semantics: when the
codex pause marker is active, drop codex from the chain (reuse the marker-reading
logic; a CLI-level equivalent already exists for tests via SMITHERS_CODEX_PAUSED).
`--model`/`--agent` build a single-agent chain with the remaining usable engines
appended as fallbacks. Review chain: same selection, and when several engines are
usable prefer a different engine for review than implement (cross-vendor review),
else same engine.

Selection code follows `ask.js` (`selectAgent`, apps/cli/src/ask.js:248-284) but
with the oneshot priority order and the four-engine allowlist.

## Global config

New file `~/.smithers/config.json` resolved via `accountsRoot(env)`
(packages/accounts/src/accountsRoot.js:11) so SMITHERS_HOME redirects it in tests.
There is no general global config today; this introduces it.

```json
{
  "version": 1,
  "oneshot": {
    "review": "on" | "off",
    "trivial": "direct" | "oneshot",
    "announced": true
  }
}
```

- Helpers in `apps/cli/src/oneshot/`: `oneshotConfigPath.js`, `loadOneshotConfig.js`,
  `saveOneshotConfig.js` (one export per file, filename matches export). Load wraps
  parse failures into the default
  (`{ review: null, trivial: null, announced: false }`); save is atomic tmp+rename
  mode 0600 like writeAccounts (packages/accounts/src/writeAccounts.js:26). Unknown
  top-level keys are preserved on write so future sections can share the file.
- CLI fallbacks when unset: review off (the CLI's job is speed; the agent flow
  normally asks and persists the recommended "on" before first launch), trivial
  direct (matches the recommendation; trivial routing is agent-side anyway).
- `--set-review` and `--set-trivial` each write their key and `announced: true`.

## Run UI

Source shipped with the CLI (not the seeded pack, since oneshot must work with no
`.smithers/` present): `apps/cli/src/oneshot/oneshot-ui.tsx`. Served by
registering the ui entry when the oneshot gateway/local UI server mounts the run,
plus a built-in fallback map so `smithers ui <oneshot-runId>` and `monitor` resolve
a UI for workflowName "oneshot" even though there is no `.smithers/ui/oneshot.tsx`
(known defect context: gateway mounts UIs at boot only; the built-in map avoids
depending on pack files). The gateway Bun.builds tsx from any absolute path.

Compose ONLY from shipped libraries (no hand-rolled markup where a component
exists), modeled on `examples/hijacked-chat-pipeline/ui.tsx` plus monitor patterns:

- Live chat log: `NodeChatStream` (packages/gateway-ui/src/NodeChatStream.tsx) for
  the implement node (and review node when present), over `useGatewayRunEvents`.
- Pierre diff: `PierreDiffView` from
  `smithers-orchestrator/ui/adapters/pierre-diff-view` fed by
  `useGatewayRunDiff({ runId })` (getRunDiff RPC; handle the oversized marker
  variant with an EmptyState + `smithers diff <runId>` hint).
- Controls row: cancel + resume via `useGatewayActions`; pause via
  `useGatewayRpc("pauseRun", { runId })` (pauseRun is absent from useGatewayActions;
  the monitor calls REST directly, monitor.tsx:3093-3108).
- Hijack: poll `/v1/api/runs/:runId/hijack-candidates`; when a candidate exists show
  a hijack affordance: the PTY WebSocket terminal from the hijacked-chat-pipeline
  example (ChatTranscript + ChatComposer with a Return-control action) or, at
  minimum, a copy-command button for `smithers hijack <runId>`. Ship the WS PTY
  variant if it stays within the example's proven pattern; otherwise copy-button
  first, WS as follow-up.
- Frame: `WorkflowUiShell`/`SmithersUiStyles`, `StatusPill` (normalizeStatus),
  `KpiStat` header (status, model/engine, elapsed, files changed), `RunEventLog`
  tab for monitor basics, `EmptyState` for zero states.
- Boot via `createGatewayReactRoot(<App/>)`, honor `?runId=`.

## Skill, docs, plugin guidance

Docs-driven: land these with (actually before, in commit order) the code.

1. `skills/smithers/SKILL.md` (hand-authored source):
   - Soften "A workflow is a superset of a skill" (:233-264) and "When to use
     Smithers vs. just answering" (:639-652): simple single-agent asks route to
     `smithers oneshot`; the high bar is for multi-step/durable/reusable work.
   - New section "Simple tasks: smithers oneshot" carrying the full agent contract
     from this spec (three routing tiers incl. direct handling of most-trivial
     asks, clarify-first, model preference, availability gate, first-run
     announcement + both preference questions with recommendations, explicit
     override phrases, the `.smithers/workflows/oneshot.tsx` user override,
     background + UI, context hygiene via single-call transcript reads).
2. `docs/cli/overview.mdx`: bump `commands[101]` to `commands[102]`, add the
   oneshot catalog entry (name, purpose, args, flags) in the chat-create format
   (:401-405). check-docs gates the count and the coverage test boots --help.
3. `docs/guides/agent-operating-playbook.mdx` (:105-107 area): add the oneshot
   routing paragraph.
4. `claude-plugin/hooks/session-start.mjs`: one added line in the workflow rule
   text: simple asks go through `smithers oneshot`; and
   `claude-plugin/hooks/prefer-smithers.mjs` advisory mention.
5. Regenerate bundles: `pnpm docs:llms` (SKILL.md is copied to apps/cli/docs and
   the llms-full mirrors; check-llms gates drift). No em-dashes anywhere in
   docs/ or SKILL.md prose.
6. Distribution is automatic: installCuratedSkill/refreshCuratedSkills rewrite the
   installed skill on upgrade (hash change).

## Evals

New suite `evals/suites/oneshot-routing/` (auto-discovered by
evals/harness/run-all.ts; no registration):

- `eval.tsx`: `export default createFluencyEval({ suite: "oneshot-routing" })`.
- `cases.jsonl`, modeled on orchestration-behavior (judge rubrics, judgeModel opus,
  assert `verdict[0].passed`) and guidance-interactive (contains cases). Candidate
  models use the eval keys (haiku, sonnet, kimi, gemini). Cases:
  The suite covers all three routes: oneshot for simple asks, NO smithers at all
  for the most trivial asks, and a real workflow for complex asks.
  1. Ambiguous simple ask ("make the settings page better"): PASS only if the
     agent asks clarifying questions about goal/acceptance criteria before
     launching anything; FAIL if it launches oneshot or builds a workflow first.
  2. Clear simple ask (well-scoped, testable): PASS only if the agent routes to
     `smithers oneshot` (not create-workflow, not a hand-authored workflow) and
     names the preference order codex sol first, kimi second, claude fable/opus
     otherwise.
  3. Most trivial ask (typo fix, single small edit), trivial preference unset or
     `direct`: PASS only if the agent does the edit DIRECTLY itself, launching
     neither oneshot nor any workflow; FAIL if it reaches for smithers at all.
  4. Most trivial ask with stored preference `trivial: "oneshot"`: PASS only if
     oneshot with a weaker model (opus or terra), not sol.
  5. Complex multi-stage ask (migration with approvals): PASS only if a real
     workflow, NOT oneshot (guards the other direction).
  6. Context states no usable agent CLI among claude/codex/kimi/opencode: PASS
     only if the agent does not offer or attempt oneshot.
  7. Context states oneshot never announced (`announced: false`): PASS only if
     the agent announces the feature, asks BOTH preference questions (review
     round, recommended on; trivial asks direct vs oneshot, recommended direct),
     says the choices are saved in global smithers config and changeable
     anytime, and mentions `.smithers/workflows/oneshot.tsx` as the override
     point.
  8. User says "oneshot without review": PASS only if the agent passes
     `--review off` and does not re-infer.
  9. Contains case: the emitted command line contains `smithers oneshot` and a
     `--model` value from the allowed set; mustNot contain `make-workflow` /
     `workflow run create-workflow`.
- `NOTES.md`: behavior table, RED before the SKILL.md change and GREEN after
  (orchestration-behavior NOTES framing), and the Running block.
- CI only typechecks evals (`pnpm typecheck:evals`); suites run offline. Cases and
  eval.tsx must typecheck.

## Tests (real behavior, no route-mocks)

- apps/cli: oneshot command registered and documented (docs-cli-overview-coverage
  passes); `--status` JSON shape; availability gate red path (empty PATH via env,
  no usable agents error); config load/save round-trip under SMITHERS_HOME temp
  dir including preserve-unknown-keys and corrupt-file fallback; model chain
  resolution (sol first; codex paused drops codex; --model slot mapping; trivial
  slots resolve); buildOneshotWorkflow shape for review on/off (two tasks vs one,
  sequence ordering, schema keys, no hijack flag).
- db-encapsulation-boundary allowlist updated only if a new file opens Database.
- UI: gateway Bun.build boot check for oneshot-ui.tsx (build must succeed);
  assert the parsed model/props where happy-dom rendering is unreliable (CodeView
  does not paint under happy-dom; assert the parsed diff model instead).
- Windows/CI hygiene: no POSIX path assertions, no mock.module on node builtins,
  subprocess-output assertions avoided (local sandbox cannot capture child stdout).

## Gates before landing

pnpm typecheck; pnpm lint; pnpm -C apps/cli test; targeted package tests for any
touched package; node scripts/check-docs.mjs; pnpm docs:llms then
node scripts/check-llms.mjs; pnpm typecheck:evals. Lockfiles must not change (no
new deps expected; pierre/diffs is already a packages/ui dependency).

## Constraints

- Work happens in an isolated git worktree off main. Never touch the concurrent
  audit-fix-train lane's files (packages/server/src/browser.js, browser tests,
  gateway rpc browser-context/pick surfaces).
- Commit with explicit pathspecs only; never git add -A / commit -a; the main
  checkout index is shared and racing.
- Dependency changes (none expected) would need pnpm-lock.yaml + bun.lock in the
  same commit.
- Prose style: no em-dashes in docs/SKILL text; plain, non-AI-sounding prose; no
  bolded-label-colon bullet walls in docs.
- The CLI runs under bun, not node.
