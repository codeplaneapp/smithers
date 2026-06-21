# Context engineering + the three execution levers

Work order for a Smithers run. Three deliverables, each goal-based with
measurable acceptance criteria. Opus 4.8 plans/writes-docs/reviews; Codex 5.5
implements code. The engine feature ships as a PR from a worktree.

This spec is the durable artifact. The code and docs are the compiled output.
If a run gets messy, rebase THIS spec and rerun — do not patch the mess.

---

## Why we're doing this

Smithers should teach, in its own docs, the mental model its maintainers
actually use to get top results from agents — and back two of those levers with
real primitives. We looked at `examples/swe-evo` and confirmed the quality lever
(model-diverse `<Panel>` planning + a `<ReviewLoop>` hill-climb) is real but
under-documented, the cost lever has no first-class primitive, and the speed
lever has a known frame-barrier limitation we want to fix.

There are three things you can optimize, and they trade off:

1. **Quality** — more attempts, more diversity, more verification.
2. **Cost** — cheaper models where an eval proves they're good enough.
3. **Speed** — parallelism, and not blocking fast work behind slow work.

---

## The philosophy to encode (source material for the docs)

This is the content the docs deliverable must turn into prose. It is one
coherent doctrine: **context engineering**. Everything below belongs in the
single context-engineering doc, not scattered.

### A model call is stateless; context is the only control surface
For a fixed model, performance is a function of context quality. The agent is a
feedback loop that repeatedly manufactures a better context window. The three
context moves: (1) delete incorrect context (worst kind — a false anchor that
causes tunnel vision; only keep wrong paths if distilled to "tried X, failed
because Y, don't repeat"), (2) add missing context (what tools are for: turn
unknowns into real tokens — tests, diffs, traces, file reads), (3) remove
useless context (a tax; cross-task residue is adversarial noise — "if you can
/clear, you should /clear"). Compression scales all three.

### Hill climbing — two hills
Hill-climb the *output* (generate → critique → regenerate) and, higher-leverage,
hill-climb the *context* (ask "what information would make the next attempt
obviously better?"). Smithers' `<ReviewLoop>`/`<Panel>` are these loops made
durable. The swe-evo panel is the worked example: model-diverse panel plans, a
review loop climbs toward reviewer approval (a proxy for the hidden tests).

### The smart zone
Agents perform best under ~200k tokens of context, ideally under ~100k. Give an
agent a goal it can finish inside that budget, with research/planning prepared so
it spends the budget on the work, not on discovery. This is why research/plan
steps precede implementation. Smithers measures this:
`smithers.tokens.context_window_per_call` is a histogram bucketed at exactly
`[50k, 100k, 200k, 500k, 1M]`; `smithers.tokens.context_window_bucket_total`
counts hits per bucket; per-node usage shows in `smithers node` and live as the
`TokenUsageReported` event (🧮). The in-workflow guardrail is
`<Aspects tokenBudget={{ max, onExceeded }}>`.

### Plan the validation, not the feature
Your scarce resource is deciding how you'll KNOW it worked. Different pipeline
stages have radically different review cost: vibe-checking output is near-free
but lets debt pile up; reading a 500-line diff is miserable; reading a *plan* is
cheap and high-leverage. So put your eyeballs where they're cheapest: review the
plan, then test the output, skip the diff. This only works with (a) plans with
teeth (they name the tests, acceptance criteria, and machine-checkable "done")
and (b) real backpressure (tests, CI, types — the agent feels resistance from the
toolchain, not from you squinting at 11pm). One-shot probability rises sharply
when a complex feature is preceded by a vetted plan (40% → ~98%).

### Goal-based over ambiguous tasks
Emphasize validation criteria; de-emphasize implementation details UNLESS a
planning step already worked them out (to save the implementer's context).
Measurable goals are best. When a goal is fuzzy, the goal can be "an agent (or
human) approves" — prefer an agent reviewer. Validation prompts deserve real
thought; a sloppy reviewer prompt is a broken feedback channel.

### Observability is non-negotiable
An agent must always be able to self-validate and debug. If it cannot (no test
signal, no trace, a broken feedback channel like the EVM tracer story), that is a
FATAL error — stop and unblock, do not proceed optimizing around a phantom
signal. When implementing a feature, invest in future observability so the next
agent can debug it.

### Testing bar is higher for agentic code
Never consider a feature working without an e2e test that proves it. E2e tests
are the bread and butter; unit tests also exist (TDD works for small snippets).
Build in **vertical slices** (one feature end-to-end) not horizontal (a whole
service for all features) — a direct consequence of e2e-first: validate sooner.

### Attention is finite; delegate the periphery
Keep linters, style guides, commit-crafting, and other periphery OUT of the
primary agent's attention. Push them to cheaper models (e.g. Kimi) in separate
passes with fresh, clean context. For git, lean on Smithers' automatic jj
snapshotting rather than spending agent attention on it.

### POC in the planning phase
A throwaway POC is a powerful way to surface planning ideas. POCs optimize for
speed and cost, NOT quality — they are discarded; their lessons feed the plan.

### Don't over-granularize (it's micromanagement)
Give an agent a goal it can achieve in the smart zone, or orchestrate many agents
to achieve a bigger one — then let it figure out the how. Task size scales with
agent power: Kimi/Sonnet do less than SOTA Opus/Codex; Fable is very powerful.

### Sandwich delegation
Smarter agents plan and review/validate/polish the ends; cheaper agents
implement in the middle. Recurse as tasks grow (e.g. Fable writes a Smithers
script whose panel uses Opus+Codex to plan and a review loop to validate while
Sonnet/Kimi implement). The more cost-insensitive you are, the more you can let
Codex implement or Fable plan — but never spend Fable on what Opus/Codex can do
unless explicitly told to; it is too expensive.

### Smithers embeds this for you
The point of the user-facing doc: Smithers bakes context engineering into the
agent itself, so the user mostly describes outcomes. The user docs should be
SHORT, say this, and tell the reader they can just ask their agent for a rundown
of how to do context engineering with Smithers and what the agent is known to do
when authoring Smithers scripts.

---

## Decisions already made (do not relitigate)

- The quality/cost/speed triad and the smart zone go into the **single**
  `docs/guides/context-engineering.mdx` — ONE doc, not a new sibling guide.
- User docs are SMALL: smithers embeds context engineering into the agent; show
  that you can ask an agent for a rundown + a quick list of what the agent does
  when writing Smithers scripts. (Likely `docs/guide/*` — pick the right home.)
- Agent docs (`skills/smithers/SKILL.md`) get a concise section; full treatment
  lives in `docs/` and flows to `llms-full.txt` via the manifest.
- Cost lever ships as a new composite component **`<Sidecar>`**.
- Speed lever: per-completion re-render ALREADY ships (#271, verified in code).
  The PR makes it an explicit, observable contract (trigger reason + frame event
  + reversible flag) and fixes the stale Aspects `.d.ts`. See Deliverable 3.
- FIX the stale claim "`<Aspects>` ... runtime enforcement is not implemented
  yet" in `skills/smithers/SKILL.md` (and anywhere else): it IS enforced at
  dispatch; a breach throws `ASPECT_BUDGET_EXCEEDED`.

---

## Deliverable 1 — Docs (Opus 4.8)

Turn the philosophy above into docs. Keep the house style: no em-dashes, no
"not X but Y", no padding triads, no hedging (see `docs/` conventions and the
check-docs gate). Conceptual prose may use a Head-First + Kernighan voice;
reference prose is pure Kernighan.

Scope:
1. **`docs/guides/context-engineering.mdx`** — extend the existing layered model
   with: the three levers (quality/cost/speed and their tradeoffs), the smart
   zone (with the real metric names and `<Aspects tokenBudget>`), hill climbing
   context, plan-the-validation, goal-based tasks, observability-as-fatal, the
   testing bar + vertical slices, attention/delegation (sandwich), POC-in-
   planning, and don't-over-granularize. It must reference the real primitives
   (`<Panel>`, `<ReviewLoop>`, `<Aspects>`, `<Sidecar>`, `<TryCatchFinally>`,
   `<ContinueAsNew>`) and the swe-evo panel as the quality example.
2. **A worked example** of a reusable component that forces a context handoff:
   wrap a `<Ralph>`/`<Loop>` ("the little while loop") in
   `<Aspects tokenBudget={{ max, onExceeded: "fail" }}>` and
   `<TryCatchFinally catchErrors={["ASPECT_BUDGET_EXCEEDED"]} catch={...}>` so
   that when accumulated context exceeds the budget the breach is caught and the
   catch branch renders `<ContinueAsNew state={...} />`, handing off to a fresh
   clean context (durable "/clear"). Carry the minimal distilled state forward.
   This example MUST be a real compiling workflow that `smithers graph` renders —
   put the runnable version under `examples/` (or `.smithers/`) and embed it in
   the doc, so it cannot rot.
3. **User docs (small)** — short page: smithers embeds context engineering into
   the agent; ask your agent for a rundown; quick list of what the agent does
   when authoring Smithers scripts (plan→validate, smart zone, e2e-first,
   sandwich delegation). Pick the right home under `docs/guide/`.
4. **Agent docs** — concise section in `skills/smithers/SKILL.md`; fix the stale
   `<Aspects>` enforcement line. After doc edits, regenerate the bundles
   (`pnpm docs:llms`) and regenerate the seeded pack if `.smithers/` changed.

Acceptance criteria (machine-checkable):
- `pnpm typecheck` green.
- check-docs and check-llms gates green (run `pnpm docs:llms` and commit
  bundles; em-dash / coverage gates pass).
- The handoff example renders: `smithers graph <example> --input '{...}'` exits 0.
- Opus self-review confirms every philosophy section above is present and the
  stale `<Aspects>` line is gone. No em-dashes anywhere added.

## Deliverable 2 — `<Sidecar>` composite component (Codex 5.5 implements; Opus plans + reviews)

A composite that runs a cheap "shadow" model alongside the primary task, scores
both with the same scorer/eval, and reports the score delta WITHOUT affecting the
run's result. This is the cost lever: over time you see whether the cheap model
is good enough to promote.

Design constraints (Opus owns final design in the plan step; this is the intent):
- Lives in `packages/components/src/components/Sidecar.js` + `SidecarProps.ts`,
  exported like the other composites; one export per file; colocate props.
- Composes existing primitives (`<Parallel>`, `<Task>`, scorers) the way other
  composites are ~20-40 lines over the substrate. Do NOT reinvent scoring.
- The sidecar (cheap model, e.g. Kimi/Sonnet) runs with `continueOnFail` so it
  can never block or fail the primary path. Its output and score are recorded;
  the primary task's output is what the workflow consumes.
- Must surface the score delta (primary vs sidecar) as structured output that
  `smithers scores` / a report can read.
- Honor dependency boundaries (check the boundaries gate) and the single-export
  /colocation conventions.

Acceptance criteria:
- `pnpm typecheck` green; dependency-boundary + single-export gates green.
- A real **e2e test** (no mocks) proves: given a primary + a cheap sidecar over
  the same input with a scorer attached, the workflow finishes, the primary
  result is unaffected by a sidecar failure, and a primary-vs-sidecar score delta
  is recorded. Unit tests cover the prop/threshold logic.
- A `docs/components/sidecar.mdx` page exists and the component is in the catalog;
  check-docs/check-llms green; bundles regenerated.
- Opus review LGTM.

## Deliverable 3 — Re-render trigger: explicit + observable contract (engine; worktree + PR)

CORRECTED SCOPE (finding, verified in code): per-completion re-render ALREADY
SHIPS. PR #271 ("advance ready loops without requiring run quiescence") removed
the frame barrier. `WorkflowDriver.executeTasks` starts the whole `<Parallel>`
set non-blocking and `nextCompletionDecision()` reports ONE settled task at a
time via `Promise.race` (packages/driver/src/WorkflowDriver.js:506-520, NOT
`Promise.all`); the live engine sets `requireRerenderOnOutputChange: true`
(packages/engine/src/engine.js:5703) and `makeWorkflowSession.js:437` returns
`{ _tag: "ReRender" }` on each completion. So do NOT re-implement dispatch. The
engine already re-renders whenever any task finishes and dispatches ready
downstream work without waiting for the slowest sibling.

The REAL remaining work makes that behavior an explicit, observable contract (the
panelists scoped this correctly; the moderator's UI-responsiveness synthesis was
wrong, ignore it):

1. **Trigger reason.** Add an optional `trigger?: { reason: "task-finished" |
   "timer-fired" | "cache-resolved" | ... }` to the scheduler render context
   (`packages/scheduler/src/RenderContext.ts`, `EngineDecision.ts`). Set it where
   `makeWorkflowSession.js` emits `ReRender` (`decideAfterOutputChange`,
   reached from `taskCompleted`/`taskFailed`/timer/cache). Thread it through
   `WorkflowDriver.renderAndSubmit` → `engine.js` `driverRenderer.render` →
   `persistDriverFrame(graph, trigger)`.
2. **Observability event.** So a future agent can see WHY a frame rendered
   ("frame N rendered because task X finished"), encode `trigger.reason` in the
   existing frame/commit event payload (extend `FrameCommitted`; do NOT add a
   breaking new event that confuses stream-replay / time-travel readers). This
   honors observability-as-fatal: the signal must be real and inspectable.
3. **Reversible contract.** Replace the hardcoded
   `requireRerenderOnOutputChange: true` (engine.js:5703) with an opts-driven
   value defaulting to `true`, so the per-completion re-render is an explicit,
   reversible option rather than a magic constant. Default behavior unchanged.
4. **Stale-claim cleanup (second finding).** `packages/components/src/index.d.ts`
   still says "Runtime budget enforcement is not implemented" even though
   `Aspects.js` source already documents enforcement and the engine enforces it
   (throws `ASPECT_BUDGET_EXCEEDED`). Regenerate the components `.d.ts` (stale
   tsup dts shadow) so the type docs match reality.

Process (practice what we preach):
- Throwaway **POC** first (Codex) to confirm the seams above
  (`reference_engine_two_scheduler_paths`: live path is `WorkflowDriver` +
  `makeWorkflowSession.decide()`). Discard it; feed lessons into the plan.
- Plan in a model-diverse `<Panel>` (Opus + Codex); Opus moderates. The moderator
  MUST preserve the panelists' grounded findings, not re-summarize into a generic
  plan.
- Implement (Codex) in the worktree. Strong observability per item 2.
- Backward compatible: default behavior identical; the full gate stays green.
- Open a PR with `gh` from the worktree (jj describe → jj bookmark set → jj git
  push --allow-new → gh pr create). Do not merge.

Acceptance criteria (machine-checkable):
- In the worktree: `pnpm typecheck` + `pnpm -C packages/scheduler test` +
  `pnpm -C packages/engine test` green.
- **e2e (no mocks, mandatory):** a workflow with two parallel tasks of very
  different durations asserts (a) the fast task's dependent work dispatches BEFORE
  the slow sibling finishes (regression proving the shipped #271 behavior), AND
  (b) the frame for the fast completion records `trigger.reason === "task-finished"`
  in its event payload. Use `createTestSmithers` / fake executors (CI has no agent
  CLIs / browsers). Unit test the trigger threading.
- `grep "enforcement is not implemented" packages/components/src/index.d.ts`
  returns nothing.
- PR opened (URL captured in output). Not merged. Opus review LGTM.

---

## Ground-truth API facts (so agents don't guess)

- Autonomous agents need bypass flags: `ClaudeCodeAgent({ model: "claude-opus-4-8",
  permissionMode: "bypassPermissions", dangerouslySkipPermissions: true })`;
  `CodexAgent({ model: "gpt-5.5", dangerouslyBypassApprovalsAndSandbox: true,
  skipGitRepoCheck: true, sandbox: "danger-full-access" })`. Never pin `cwd`
  (it overrides `<Worktree>`).
- `<Aspects tokenBudget={{ max: number, onExceeded?: "fail"|"warn"|"skip-remaining" }}>`
  enforced at dispatch; breach throws `ASPECT_BUDGET_EXCEEDED`.
- `<TryCatchFinally try={el} catch={el|(err)=>el} catchErrors={[code]} finally={el} />`.
- `<ContinueAsNew state={json} />` or `continueAsNew(state)` hands off to a fresh
  run with carried state.
- `ctx.input` fields arrive raw-or-null (coalesce). `ctx.outputs.<schema>` is the
  full row array; filter by an id field for per-item work.
- Repo gates (repoCommands are null here, call directly): `pnpm typecheck`,
  `pnpm test` (runs check-single-effect-version, check-dependency-boundaries,
  check-docs, check-llms, then `pnpm -r test`), `pnpm -C e2e test`,
  `pnpm docs:llms`, and regenerate the seeded pack after `.smithers/` edits.
- CI runs with NO agent CLIs and NO browsers: tests must seed a fake agent and
  skip browser-only e2e or they go red in CI while green locally.
