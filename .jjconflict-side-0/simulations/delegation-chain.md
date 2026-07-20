# Delegation Chain — bootstrap simulation ledger

> **What this is.** A frame-by-frame thought experiment: we simulate the
> `delegation-chain` workflow running on the task *"build the delegation-chain
> feature itself"* — as if the feature already existed. Each frame shows (a) the
> delegation database state (the flux store contents) and (b) the UI frame a
> user would see. No code executed inside the simulation; it calibrates the
> design before the real build. If the real implementation, later used to
> migrate plue, matches how these frames behave, the design worked.
>
> **How to read it.** `▣` done · `▶` running · `◌` planned · `⚠` awaiting-human
> · `✕` invalidated. `att:n` = attention rollup (self-or-descendant needs a
> human). Frames only show deltas.

---

## The data model the frames use (this is the spec)

```ts
type Tier = "fable" | "opus" | "sonnet" | "haiku";        // configurable; these are defaults
type NodeKind =
  | "goal"          // phase-0 goal refinement
  | "chunk"         // a decomposition node owned by one agent at some tier
  | "preview"       // zero-backpressure haiku expected-output render
  | "research"      // haiku doc-reading probe (answer + sourced report)
  | "poc"           // prove-it-works probe delegated by a parent
  | "review"        // a backpressure gate realized as an agent review
  | "score";        // scoring node

type Gate =
  | { method: "review"; agentTier: Tier; brief: string }
  | { method: "check"; command: string }                   // typecheck/test/eval
  | { method: "approval"; policyMatch: string };           // only when approval policy applies

type DelegationNode = {
  id: string;
  parentId: string | null;
  tier: Tier;
  kind: NodeKind;
  title: string;
  brief: string;              // the context-engineered prompt handed to this node
  status: "planned" | "previewing" | "derisking" | "ready"
        | "running" | "awaiting-human" | "invalidated" | "done" | "failed";
  version: number;            // bumps on invalidation; all prior versions retained
  deps: string[];             // execution-order + backpressure dependencies
  gates: Gate[];              // this node's declared backpressure
  attention: { self: boolean; descendants: number };   // needs-human rollup
  estimate?: { tokens: number; costUsd: number; minutes: number };  // predicted, re-forecast on replan
  actual?: { tokens?: number; costUsd?: number; minutes?: number }; // rolled up as it runs
  output?: unknown;           // editable in the UI — edits are events, see below
};

// Flux events — the ONLY way the graph changes. The reducer is pure and
// non-React; React renders declaratively from the folded state.
type DelegationEvent =
  | { t: "QUESTION_ASKED"; q: Question }        // phase 0; forms prefetched ~10 ahead
  | { t: "QUESTION_ANSWERED" } | { t: "PROMPT_REFINED" } | { t: "PROMPT_APPROVED" }
  | { t: "CHILDREN_DECLARED"; parent: string; children: DelegationNode[] }  // streams
  | { t: "PREVIEW_RENDERED"; node: string }     // carries the never-executed warning
  | { t: "PREVIEW_SKIPPED" }                    // user pressed skip in the UI
  | { t: "GATES_DECLARED"; node: string; gates: Gate[]; deps: string[] }
  | { t: "RISK_FLAGGED"; node: string; risk: string }        // scorer input!
  | { t: "PROBE_SPAWNED"; parent: string; probe: "poc" | "research" }
  | { t: "FINDING_REPORTED"; probe: string; toParent: string }  // nearest parent only
  | { t: "REPLAN_REQUESTED"; from: string; reason: string }
  | { t: "NODE_INVALIDATED"; node: string }     // version++ ; old version archived
  | { t: "NODE_REAFFIRMED"; node: string }      // explicit "my plan survives the change"
  | { t: "USER_EDITED_OUTPUT"; node: string }   // live WYSIWYG edit → invalidation round
  | { t: "EXEC_STARTED"; node: string } | { t: "GATE_PASSED" } | { t: "GATE_FAILED" }
  | { t: "REDELEGATED"; node: string }          // failed review → new attempt version
  | { t: "NODE_DONE"; node: string }
  | { t: "SCORED"; node: string } | { t: "POLL_SUBMITTED" };
```

Cross-cutting rules active in every frame:

- **Auto by default.** No approval gates exist unless an approval-policy prompt
  was passed at launch; any agent may add one only where the policy applies,
  and may hand its children a clarified version of the policy.
- **Context engineering is the system prompt** at every *delegating* tier
  (fable/opus). Leaf executors (sonnet) and probes (haiku) get lean task briefs.
- **Reports bubble via the nearest parent only.** No node ever sees the whole
  tree in context.
- **Every output rendered in the UI is editable** (MarkdownEditor from
  `ddd-shared`). A user edit emits `USER_EDITED_OUTPUT`, which runs the same
  bubble-up invalidation round as a probe finding.
- **Versions are history.** Clicking a node shows its version list; clicking a
  version shows the archived (invalidated) state of that node.
- **Reviews judge evidence, not summaries.** Every review step receives the
  reviewed node's output (per that node's own output spec) AND the range of jj
  commits the task produced (`dcExec.commitRange`), with access to inspect all
  of them and generate any diff itself (`jj log/diff/show -r from..to`).
  Chunk-level reviews get the union of their subtree's ranges.

---

## Frame 0 — launch

User launches: `smithers up delegation-chain --prompt "<the ambiguous ask>"`.

```
DB    nodes: [goal g0 (fable) ▶ awaiting-human att:1]
      events: [QUESTION_ASKED q1..q4, prefetch queue rendering q5..q10 (haiku)]
UI    ┌──────────────────────────────────────────────┐
      │ ⚠ goal: refine "migrate plue via delegation" │   ← single node, pulsing
      └──────────────────────────────────────────────┘
      Side panel: Q1 of ~4 · [form, default prefilled] · queue: 6 more prefetched
```

The fable goal agent forecast **4** user-preference questions (bootstrap scope,
open-sourcing intent, Go posture, form rendering) and answered every
implementation question itself. Haiku form-render tasks stay ~10 ahead;
questions q5–q10 were prefetched but **never shown** — the agent resolved them
as implementation decisions after q1–q4's answers narrowed the space. (This
frame is exactly what happened in the real session that produced this file.)

## Frame 1 — refined prompt approved

```
DB    g0 ▣ done, output = refined prompt (markdown, editable)
      events: +PROMPT_REFINED +PROMPT_APPROVED
UI    goal node solid; refined prompt shown in MarkdownEditor; [Approve] clicked
```

Refined goal: *build the delegation-chain workflow + UI + stdlib pieces; the
plue migration is run #1, owned by the user, out of build scope.*

## Frame 2 — Fable decomposition (streams)

The root is **one Fable-sized chunk** — the whole feature fits one strong
planning context; it splits by *execution* context windows, not by planning
need. `CHILDREN_DECLARED` streams: `core` renders before `packaging` exists.

```
DB    nodes: +root r0 (fable ▣ planned) → chunks c1..c5 (opus ◌, streaming in)
UI    goal ▣ ─ r0 ▣
                ├─ c1 core       (opus ◌)  schemas + flux reducer + useDelegationChain
                ├─ c2 components (opus ◌)  stdlib composites + prompts
                ├─ c3 scorers    (opus ◌)  4 scorers + weighted aggregation
                ├─ c4 ui         (opus ◌)  graph canvas + inspector + forms
                └─ c5 packaging  (opus ◌)  ← rendered last, tree grew live
```

Each opus chunk then declares sonnet leaves (c1 → schemas / reducer+tests /
hook-wiring, c4 → canvas / inspector / question-queue, …). Depth 3, ~17 nodes
total — a deliberately small graph, matching the ask's size.

## Frame 3 — zero-backpressure preview (default on)

Haiku renders the *expected output* of every leaf with zero backpressure.
Example, leaf `c1.reducer`:

```
DB    events: +PREVIEW_RENDERED ×9 (haiku, parallel, ~0 cost)
UI    each leaf gets a dashed "expected output" card:
      ┌─ ⚠ NEVER EXECUTED — calibration only ─────────────┐
      │ function reduce(state, ev) { switch (ev.t) {      │
      │   case "NODE_INVALIDATED": /* version++, archive  │
      │      old, cascade to dependents via deps graph */ │
      └───────────────────────────────────────────────────┘
      [Skip previews] button visible; user does NOT skip
```

Calibration catch: the previewed reducer treated `deps` as parent-child only.
The opus owner of `c1` reads the preview and tightens the brief: *deps include
backpressure edges; invalidation cascades along BOTH.* Cheap fix, pre-execution.

## Frame 4 — backpressure planning

Every node declares its gates and dependencies (`GATES_DECLARED`); the UI adds
gate badges and dependency edges to the existing tree.

```
DB    c1: gates [check "bun test pkg", check "pnpm typecheck", review(fable)]
      c2: deps  [c1]  gates [review(fable), check typecheck]
      c3: deps  [c1]  gates [check "bun test", review(opus)]
      c4: deps  [c1(hook API)]  gates [review(fable: UX pass), check typecheck]
      c5: deps  [c1..c4] gates [check "check-docs", check "check-llms", review(fable)]
UI    edges: c2──▶c1  c3──▶c1  c4──▶c1  c5──▶all ; gate chips on each node
```

## Frame 5 — research & POC pass (risk hunting)

Owners recursively flag risk (`RISK_FLAGGED` — this is scored later) and spawn
probes:

```
DB    +poc p1   (parent c4, haiku→sonnet): "prove ReactFlow re-layout survives
                 live node invalidation + version swap without jank"
      +research h1 (parent c1, haiku): "can the flux store derive everything
                 from existing gateway events/outputs, no engine changes?"
      +research h2 (parent c5, haiku): "what can a SEEDED workflow import?
                 (init-pack bundling constraints)"
      c2, c3 owners emit NO probes — they judge their chunks routine (scored!)
UI    probe nodes hang off their parents, dotted borders, att badges while running
```

## Frame 6 — findings bubble, replan cascades

```
DB    h1 → FINDING: yes for graph state (events + node outputs suffice), BUT
           interactive questions need json-kind durable human requests
           (packages/engine human-requests) — not plain Task output polling.
           → REPLAN_REQUESTED(from c1) → NODE_INVALIDATED c2 (version 1→2):
             GoalRefinement must ride HumanTask/json-kind, not ask_human chat.
      h2 → FINDING: the init pack bundles workflow+prompts but NOT
           .smithers/components — reusable composites MUST live in
           packages/components to ship.  → c2 reaffirms (already planned so)
           → NODE_REAFFIRMED c2, c5.
      p1 → FINDING: works; dagre re-layout ok if versions swap in place and
           only NEW nodes animate. Report (sourced) delivered to c4 only;
           c4 folds it into its brief and reaffirms.
UI    c2 shows ✕v1 ghosted behind ▣v2 — click c2 → "Versions: v2 (current), v1
      (invalidated: human-request plumbing)" → click v1 → archived state view
```

The cascade is the flux reducer at work: one `NODE_INVALIDATED`, dependents get
`REPLAN_REQUESTED`, each either re-plans (version++) or `NODE_REAFFIRMED`.
Nothing re-renders imperatively; the UI just re-derives from folded state.

## Frame 7 — a live user edit mid-plan

The user reads c4's plan output in the inspector and **edits it in place**
(MarkdownEditor): *"reuse the DDD WYSIWYG editor for all doc-shaped outputs;
every output stays editable at runtime; keep invalidated versions clickable."*

```
DB    +USER_EDITED_OUTPUT(c4) → bubble-up round: c4 re-plans (v1→v2, folds the
      edit in), r0 reviews the diff → REAFFIRMED (no sibling impact); c1 asked →
      REAFFIRMED (store already event-sourced; versions already archived).
UI    c4 badge "edited by user · replanned v2"; graph otherwise stable
```

(Also exactly what happened in the real session — two mid-flight user messages
were absorbed as edits, not restarts.)

## Frame 7b — another live edit: cost/time estimation

A second `USER_EDITED_OUTPUT` lands mid-plan (in the real session: shazow's
suggestion, relayed live): *every plan node must predict tokens/cost/time; the
run shows a progress bar of `$actual of $latestPredicted`; estimates are scored
against actuals; budgets are enforceable.*

```
DB    +USER_EDITED_OUTPUT(r0) → bubble-up round touches EVERY delegating node
      (estimates are a planning-output field): r0, c1..c5 re-emit plans v+1
      with per-child estimates + subtree rollups. Replans re-forecast, so the
      run-level prediction is always the LATEST rollup, not the first guess.
      +gate on r0: Aspects budget guard — error if actualUsd > maxUsd (soft
      warn at 80%).
UI    header gains: ▓▓▓▓▓░░░░ $3.20 of ~$11.40 · ~22 min left ; nodes gain
      estimate chips (pred vs actual, red when over)
```

New scorer registered for Frame 10: `estimateAccuracy` — |actual−predicted|/predicted
per node, aggregated; easy, fully automatic backpressure on planning honesty.

## Frame 8 — plan believed solid → execution begins

All nodes `ready`; execution walks the dependency graph with max parallelism:
`c1` first (everything depends on its API), then `c2‖c3‖c4`, then `c5`.

```
DB    EXEC_STARTED c1 → leaves run (sonnet) → gates: bun test ✓ typecheck ✓
      review(fable) ✓ → NODE_DONE c1
      EXEC_STARTED c2, c3, c4 (parallel)
UI    nodes fill with live status; every frame durable; attention rollup counts
      at each ancestor while any descendant awaits a human
```

## Frame 9 — a gate fails, redelegation

```
DB    c4.inspector: review(fable) FAILS — "version history renders newest-first
      but selects oldest; attention rollup double-counts via backpressure edges"
      → GATE_FAILED → REDELEGATED c4.inspector (attempt 2, sonnet, brief now
      includes the review verdict) → gates pass → NODE_DONE
UI    c4.inspector shows attempt history (v1 ✕ review-failed, v2 ▣)
```

## Frame 9b — developer previews (backpressure that you can see)

Nodes whose gates include `preview` build their DEVELOPER PREVIEW after
execution — it is backpressure: the artifact must build successfully or the
node fails like a failed review.

```
DB    c4 gates: [..., preview(kind: throwaway-ui, "render the delegation graph
      UI against a canned run")] → dc:c4:dev-preview runs post-exec →
      dcDevPreview { builtOk: true, artifact: { type: "html", content: ... } }
      r0 gates: [..., preview(kind: slideshow)] → planning-level slideshow of
      everything done so far (no runnable code needed at that altitude)
UI    node grows a "Preview" chip; inspector gains a Developer Preview panel
      (iframe for html, instructions for terminal/CLI kinds, link for url).
      The panel carries [Invalidate] and [Request changes] — inherent to any
      preview: pressing one emits a dc-edit round (same cascade as frame 7).
```

Kinds: `app` (the built thing itself), `terminal` (rendered terminal + CLI
instructions), `api` (explorer over a built API), `throwaway-ui`, `slideshow`
(the fallback when a node only planned — progress is still showable).

## Frame 10 — completion + scoring

```
DB    all NODE_DONE → score nodes run:
      pocJudgment  r0 ✓ flagged nothing, nothing broke        → reward (correct negative)
                   c4 ✓ flagged ReactFlow risk, POC confirmed  → strong reward (correct positive)
                   c1 ✓ spawned h1, finding CHANGED the plan   → strongest reward
                   c2 ✗ none flagged, but h1's finding forced its replan —
                        the risk lived in c2's domain          → false negative, punished hardest
      planSolidity 1 invalidation + 1 redelegation post-exec-start → 0.82
      tierFit      haiku probes: quality/cost excellent; c2 leaves could have
                   been cheaper (short outputs, high tier)     → 0.74
      estimateAccuracy  run predicted $11.40 / actual $9.87 → 0.87; c4 under-
                   estimated 2.1× (the redelegation) → per-node breakdown kept
      humanPoll    ⚠ awaiting-human: 3-question poll rendered in UI
UI    scores panel per node + weighted run total (weights configurable);
      poll form is the last attention badge in the graph
```

## Frame 11 — done

User submits the poll; run total finalizes. Every frame above is replayable
(time travel), every invalidated version inspectable forever.

---

## What the simulation changed (calibration deltas → the real build)

1. **Questions ride durable human requests** (`json` kind + JSON Schema), not
   chat-side `ask_human` — that's what makes forms, prefetch, and the attention
   rollup possible. (From h1 — found *before* code existed.)
2. **Reusable composites go in `packages/components`**, not
   `.smithers/components/` — seeded packs don't bundle the latter. (From h2.)
3. **Invalidation cascades along dependency AND backpressure edges**; the
   reducer archives versions instead of overwriting. (From the preview frame.)
4. **User edits are ordinary events** — same code path as probe findings. No
   special "user override" machinery. (From frame 7.)
5. The graph stays legible because probes hang off parents and reports bubble
   one hop — full-tree context never enters any prompt.
6. **Estimates are planning outputs, not metadata** (frame 7b): every plan
   carries tokens/cost/time predictions, replans re-forecast, actuals roll up,
   and `estimateAccuracy` scores the gap automatically. Budgets enforce via
   the existing `<Aspects>` guard. The `$actual of $latestPredicted` progress
   bar falls out of the same fold — no new machinery.

The node tree in frames 2–10 **is** the implementation plan for the real build
that follows this commit.

---

## Future work (planned, deliberately deferred)

1. **Higher-order orchestration (v2).** Fable nodes will be able to *author a
   smithers workflow* — given the standard component library — as their node's
   execution strategy: their own state machine, arbitrary orchestration, not
   just serial/parallel child-task decomposition. Smarter planning, at the cost
   of a much harder UI (rendering arbitrary authored subgraphs) and debugging
   story — which is exactly why v1 ships without it. v1 reserves the seams:
   `dcPlan.orchestration?: "tasks" | "workflow"` (optional, default "tasks")
   and `// v2 higher-order orchestration:` comments at the four extension
   points (plan schema, planning fan-out → `<Subflow>` mount, reducer child
   edges, UI subtree renderer as a nested collapsed graph).
2. **Flux store on Effect.ts.** After v1 gates green, `foldDelegation` + the
   record-assembly store behind `useDelegationChain` get rebuilt on Effect
   (repo already enforces `check-single-effect-version`). The hook signature,
   `DelegationGraph` shape, and the reducer test suite are frozen — the tests
   pin behavior, so the rewrite has a hard conformance harness.
