# The Claude Workflow API: a cosmetic skin over the Effect kernel

> **Written for Smithers 0.x.** This note is research from before the 1.0
> rewrite. It describes the JSX workflow runtime, its CLI, or its gateway, none
> of which exist in 1.0.0-rc.0. It is kept as history, not as guidance; see
> `docs/pages/migration/1.0.md` for what replaced each surface it names.

**Status:** design proposal v2, 2026-07-27. Supersedes v1 (which proposed a new replay driver beside the JSX reconciler; unnecessary — the replay kernel already exists under the Effect API).
**One sentence:** ship a Claude-only authoring skin that is *source-compatible* with the Claude Code native Workflow tool's script API, implemented as a thin cosmetic wrapper over the Smithers Effect API — whose `@effect/workflow` foundation already is a deterministic-replay durable-execution engine — making Smithers the first orchestrator to ship *per-platform authoring skills*: Claude sessions author in the shape Claude is system-prompt-trained on, and the durable engine underneath never changes.

---

## 1. Architecture directive (the point of v2)

**The Effect API is the kernel. Everything else is cosmetic.**

```
@effect/workflow + @effect/cluster           replay journal, Activity, DurableDeferred,
  (already in packages/engine/src/effect/)   durable timers, entity runner
        ↑ existing bridges: activity-bridge, durable-deferred-bridge,
          deferred-state-bridge, entity-worker, single-runner
Smithers Effect API                          G.step/approval/sequence/parallel/match/
  (builder.js, docs/effect/overview.mdx)     branch/loop/worktree/scope  +  NEW: Smithers.script
        ↑ cosmetic skins, one per audience
  React/JSX ....................... today's canonical surface; target state: compiles to Effect
  Claude Workflow script (NEW) .... Claude-platform skill, this doc
  (future) Codex / Gemini skins ... whatever those platforms train their models on
```

Two consequences:

1. **No new execution machinery.** v1's `renderScriptFrame`, quiescence detection, and journal-matching design are all deleted. `@effect/workflow` already executes a workflow body as an Effect re-run from the top on resume, with `Activity` results memoized in durable storage and `DurableDeferred` for external resolutions. That *is* the replay model; Smithers already bridges it to its DB, attempt rows, approvals, timers, and wait-for-event nodes.
2. **No feature parity requirement.** The Claude skin is deliberately smaller than the React API. It exposes the native Claude surface verbatim plus the few durables the kernel gives nearly free. Anything else (scorers, memory, fork, cache policies, proof bindings, subtree concurrency) stays in the JSX/Effect surfaces; a script that outgrows the skin graduates to them.

---

## 2. Why a Claude-shaped skin at all

Compressed from v1 (see git history for the full argument):

- **The Claude Workflow tool script API is embedded verbatim in every Claude Code system prompt.** Claude one-shots this shape — `meta` + `agent()/parallel()/pipeline()/phase()/log()/args/budget/workflow()` — with zero docs fetched, including the subtle parts (thunks for `parallel`, null-on-error filtering, no `Date.now()`).
- **The native contract is already a deterministic-replay contract.** Its resume replays the longest unchanged prefix of `agent()` calls from a journal, and it bans `Date.now()`/`Math.random()`/argless `new Date()` explicitly because "they would break resume." Anthropic trains every Claude to write pure functions of `(args, journal)` — exactly the purity a durable replay engine demands. The hijack: inherit that training budget.
- **JSX authoring still costs coaching** (`research/workflow-authoring-friction-postmortem.md`: ~10 of ~30 incidents in an 11-hour repair loop were pure JSX-API friction — reserved columns, nested `<Loop>`, output binding). The imperative script shape cannot express most of those failure classes.
- **The display half of the bridge already ships.** `packages/graph`'s `ClaudeWorkflowPhase*` / `classifyClaudeWorkflowNodeKind` / `buildClaudeWorkflowPhasePlan` feed `claude-plugin/workflows/smithers-run.mjs`, which mirrors Smithers runs into `/workflows`. This proposal is the authoring half; `meta.phases` round-trips through the mirror untouched.
- **This is `why-react.mdx`, part 2.** The founding thesis was "map orchestration onto a domain agents are already optimized for." In 2026, for Claude specifically, that domain is no longer React — it is this exact script API.

## 3. The native contract (what the skin must honor verbatim)

- Plain JS ESM, async body, `return` value = workflow result. `export const meta = { name, description, whenToUse?, phases? }` as a pure literal.
- Globals: `agent(prompt, opts?)` (→ text, or schema-validated object; `null` on skip/terminal failure; opts `label`/`phase`/`schema`/`model`/`effort`/`isolation:'worktree'`/`agentType`), `parallel(thunks)` (barrier; thrown thunk → `null`; never rejects), `pipeline(items, ...stages)` (no barrier; `(prev, item, index)`; throw drops item to `null`), `phase(title)`, `log(msg)`, `args`, `budget {total, spent(), remaining()}`, `workflow(nameOrRef, args?)` (one nesting level).
- Concurrency `min(16, cores − 2)`; 1000-agent lifetime cap; 4096 items per fan-out call; determinism bans as above.

A script written for the native tool must run on Smithers with **zero edits**.

## 4. Implementation: everything maps to an existing Effect primitive

### 4.1 One new Effect-API construct

```ts
Smithers.script({ name, input?, run: (S) => Promise<unknown> })
```

The script body runs as the workflow's Effect under `@effect/workflow` replay semantics: re-executed from the top on resume/rewind/fork, every effectful call durably memoized. `S` is the typed toolbox (usable from plain Effect-land too — the construct is a first-class citizen of the Effect API, not Claude-private). The Claude skin is then *purely cosmetic*: a loader that reads `meta`, binds the native globals to `S`, and registers the workflow.

**Verified kernel anchors** (2026-07-27, reading `packages/engine/src/effect/`):

- `workflow-make-bridge.js` builds the durable workflow with `Workflow.make(...).toLayer(() => execute)` — the body handed to `@effect/workflow` is an **arbitrary Effect**, and suspension (`waiting-approval|event|timer|quota`) already maps to `Workflow.suspend(instance)`. The bridge runtime exposes an `executeBody: RunBodyExecutor` seam; today the JSX render loop is the one executor plugged in. `Smithers.script` is **a second `RunBodyExecutor`**, not new machinery.
- `activity-bridge.js` wraps task execution in `Activity.make({ name: desc.nodeId })` + `Activity.idempotencyKey`; the durable memo is the task/output rows keyed `(runId, nodeId, iteration)` (the module-level LRU is a cache backstop). So `agent()` memoization = the same output-row read the JSX `ctx` does.
- `builder.js` shows the Effect surface is itself already a skin: `G.from(graph)` → `compileGraph` → `execute()` → `runWorkflow`. "Everything is a wrapper" is the existing direction of travel, not a rewrite.

### 4.2 The mapping table

| Claude surface | Effect kernel primitive | Status |
|---|---|---|
| `agent(prompt, opts)` | an `Activity` (name = node id, §5) executing the same agent-attempt machinery the JSX path uses via `activity-bridge.js`; result memoized durably | engine machinery exists; **the Effect surface has no agent-step path today** (builder steps are compute-only `run:` bodies) — exposing it is P1's core work item |
| `schema` opt | the existing structured-output ladder (native `outputSchema` where the agent supports it, prompt-and-parse fallback); accepts JSON Schema and, superset, Zod | exists |
| `parallel(thunks)` | `Effect.all(thunks, { concurrency })` with per-thunk `catchAll(() => null)` | trivial |
| `pipeline(items, stages)` | `Effect.forEach(items, chained stages, { concurrency })`, no barrier | trivial |
| `phase(title)` / `opts.phase` / `meta.phases` | annotation stamped on the activity's node row; consumed by `buildClaudeWorkflowPhasePlan` → mirror/UI | display path exists |
| `log(msg)` | run event row | exists |
| `args` / `meta.input` | workflow input (optional schema validation, superset) | exists |
| `budget` | usage/accounting reads over attempt rows | exists (wiring) |
| `workflow(name, args)` | child run via the entity runner | bridge exists |
| `isolation: 'worktree'` | worktree descriptor fields on the task | exists |
| **Superset:** `approval(req)` | `ApprovalDurableDeferredResolution` (DurableDeferred) | **bridge already written** |
| **Superset:** `askHuman(q)` | human-request durable deferred | bridge exists |
| **Superset:** `waitForSignal(name)` | `WaitForEventDurableDeferredResolution` | **bridge already written** |
| **Superset:** `sleep('2h')` | durable timer via `deferred-state-bridge` | **bridge already written** |
| **Superset:** `compute(id, fn)` | an Activity wrapping local work (makes nondeterministic/side-effectful local code replay-safe by recording its result) | trivial |
| **Superset:** `now()` / `random()` | micro-Activities (record once, replay forever); raw `Date.now`/`Math.random` still throw, matching native | trivial |

Control flow needs nothing: `parallel`, `pipeline`, loops, branches, races are plain JavaScript over promises/Effects; durability attaches only at Activity/Deferred boundaries. v1's hardest open problem — quiescence detection — does not exist here, because `@effect/workflow` owns suspension semantics (a workflow suspends on pending deferreds/timers and reconstructs in-flight structure by replaying memoized activities).

### 4.3 What stays out (deliberate non-parity)

No `scorers`, `memory`, `fork`, `cache`, `sandbox`, proof bindings, priorities, failure policies, or hijack opts in the skin. The graduation path is explicit: `smithers eject` (or by hand) rewrites a script into JSX/Effect when it needs those. Keeping the skin small is what keeps it *cosmetic* — every opt we add is surface Claude was never trained on, which erodes the entire premise.

## 5. Node identity (Activity naming)

Activities memoize by name, so the v1 identity rules survive unchanged as *naming* rules: explicit `opts.id` > `slug(opts.label)` > `a<call-seq>:<hash8(prompt)>`, occurrence counters for repeats, loop passes on the existing `iteration` dimension. Edit-and-resume gets native-tool semantics for free: unchanged prefix replays from the activity journal, first divergent name/prompt runs live. One authoring rule to document, and it is one Claude already knows: stable prompts, no wall-clock/random in them (unrepresentable anyway, given the guard).

## 6. Per-platform skills (the distribution model)

For the first time, the Smithers skill an agent receives depends on the platform it runs on:

| Platform | Authoring skill it gets | Why |
|---|---|---|
| Claude Code (plugin) | **Claude Workflow script API** — a one-page delta: "the Workflow tool API you already know, plus `approval`/`askHuman`/`waitForSignal`/`sleep`/`compute`, minus nothing" | zero-shot from system-prompt priors |
| Codex / other CLI agents | JSX skill (today); their own native-shape skins if/when those platforms standardize one | best current prior for non-Claude models is React |
| Effect-native engineers / generated definitions | Effect API (`G.*`, `Smithers.script`) | the kernel surface itself |

Mechanics: the Claude plugin ships the script skill and stops teaching JSX authoring in Claude sessions; `.smithers/workflows/*.workflow.mjs` is discovered beside `.tsx`; docs add one page + an `llms-claude-script.txt` delta bundle (regenerate via `pnpm docs:llms`). The mirror (`smithers-run.mjs`) needs zero changes. Hijack levels from v1 still apply: (1) drop-in file format, (2) plugin round-trip (`smithers claude run-script`, mirrored into `/workflows`), (3) opt-in PreToolUse redirect of the native Workflow tool.

## 7. What a script gains over the native tool

Survives session/process/machine death (resume, `supervise`); rewind/fork/replay with jj/VCS restore; durable approvals, human tasks, signals, timers, cron; any harness behind `agent()` (Claude Code subscription, Codex, API agents) via `agentType`/registry routing; typed persisted outputs and Gateway/custom-UI observability **plus** the native `/workflows` mirror view.

## 8. Plan

1. **P1 — kernel construct:** `Smithers.script` on `@effect/workflow` replay + `agent()` over `activity-bridge` + `parallel`/`pipeline`/`phase`/`log`/`args` + Activity-naming rules + determinism guard. Conformance fixtures: scripts lifted verbatim from the native tool's documented patterns (loop-until-dry, judge panel, adversarial verify, barrier-vs-pipeline) must run unmodified.
2. **P2 — durables + distribution:** `approval`/`askHuman`/`waitForSignal`/`sleep`/`compute`/`now`/`random`; `workflow()` as child run; `.workflow.mjs` discovery; `smithers claude run-script`; the Claude-platform skill + docs page + llms delta bundle.
3. **P3 — polish:** `budget` wiring to usage accounting, `meta.input` validation, `meta.ui` binding, PreToolUse redirect (disabled by default).

## 9. Open questions

- **Race semantics.** `Promise.race`/`Effect.race` over activities: does the loser keep running (durable, its result recorded for replay) or get interrupted (and is interruption itself durable)? Pick one, pin it in the conformance suite. Native scripts can race today, so this must be answered in P1.
- **Frame/timeline rendering for script runs.** Activity rows give nodes/attempts/events; confirm the timeline/rewind CLI surfaces need nothing beyond the phase-plan stamps (they read the same tables). Rewind/fork for script runs = activity-journal truncation + the existing side-effect revert guard + replay; verify the guard hooks the activity path, not just JSX tasks.
- **React-API-as-wrapper.** Out of scope here, but the directive stands: the JSX surface should ultimately compile onto the same Effect kernel (the `effect/README.md` bridges are most of the way there). This skin should add no coupling that makes that harder.
- **Caps.** Honor native caps (`min(16, cores−2)`, 1000 agents, 4096 items) as defaults in the skin; `meta.maxConcurrency` overrides.

## 10. Summary

The v1 insight stands — Claude's Workflow API is already a deterministic-replay contract, so hijacking it costs nothing — but v1 proposed building the replay engine, and Smithers already owns one: `@effect/workflow` under the Effect API, bridges included (activities, durable deferreds for approvals and signals, durable timers). So the Claude Workflow API becomes what it always should have been: a cosmetic, Claude-only skin over the Effect kernel — small on purpose, no parity with the React surface — and the first instance of per-platform Smithers skills: every agentic platform authors in the shape its models were trained on, while one kernel underneath keeps every run durable, observable, and time-travelable.
