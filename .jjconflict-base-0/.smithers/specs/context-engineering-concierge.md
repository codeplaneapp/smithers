# Context-Engineering Concierge — Roadmap

Plan for the docs, skills, and workflows that turn Smithers into a
**context-engineering concierge**: a proxy agent that takes a user's vague
script, interrogates it, turns it into a context contract, routes it to
skills/workflows, adds backpressure (tests/evals/approvals), executes as much as
possible, and reports legibly. Targets the `../smithers` repo. Every shipped
workflow must also land in `smithers init`.

Source research: FUCORY (twitter), Matt Pocock / AI Hero (`grill-me`,
"interview until shared understanding"), Dex Horthy / HumanLayer (12-factor
agents, harness engineering), Geoff / Ralph (loop-until-done, acceptance-driven
backpressure), BAML (prompt-as-schema engineering), Anthropic & OpenAI
(prompting + evals).

---

## 0. Thesis

The wrong abstraction is "write a better prompt." The right one is a layered
control system, and Smithers owns the outer layers:

| Layer | What it controls | Owner |
|---|---|---|
| Prompt engineering | instructions, examples, role, output format, success criteria | the prompt `.mdx` |
| Context engineering | what info/tools/memory/schema/state enter context each step | the workflow graph + memory |
| Harness engineering | runtime, tools, conventions, permissions, hooks, retries, fresh-context loops | agents.ts, sandboxes, tools, repoCommands |
| Workflow engineering | graph, parallelism, review loops, approvals, resumability, artifacts | Smithers itself |
| Backpressure | every desired behavior → a gate/test/eval/schema/reviewer/approval/trace | the gate matrix |

**Product thesis:** *Smithers turns a user script into an executable, durable,
observable, context-engineered workflow.* The differentiator is the **proxy
layer** — the user operates a context-engineering agent, which operates Smithers,
which operates durable workflows. The user answers business/domain questions, never
agent-engineering questions.

---

## 1. Workflows to add

Naming: the proxy is `context-engineer`; the minimal path is `route-task`;
authoring is `create-workflow` (built) and `create-skill`; the reuse loop is
`extract-skill`; quality is `backpressure-plan` / `eval-author` / `context-doctor`;
ops is `monitor-smithers` / `triage-run` / `report-slideshow`.

| Workflow | Tier | Purpose | Composes | In init? | Status |
|---|---|---|---|---|---|
| **context-engineer** | concierge | script → contract → route → backpressure → execute → report → extract | GrillMe, Research, Plan, ValidationLoop, ReviewLoop, Approval, report | ✅ yes | **new (flagship)** |
| **route-task** | concierge | classify a script; single-task vs durable workflow; run-or-recommend | classifier + executor; sub-flow of context-engineer | ✅ yes | new |
| **create-workflow** | authoring | build a new workflow (clarify→provision→design→approve→scaffold→verify→document) | own prompts; `smithers graph` verify loop | ✅ yes | **built** |
| **create-skill** | authoring | author a new agent skill (SKILL.md + assets) | mirror create-workflow | ✅ yes | new |
| **extract-skill** | reuse | after a run, harvest a reusable skill/workflow + memory writes | reads run events; writes skill/workflow | optional | new |
| **backpressure-plan** | quality | acceptance criteria → gate matrix (schema/test/eval/review/approval/trace) | reusable **component** + workflow | (component) | new |
| **eval-author** | quality | criteria → eval fixtures (jsonl + rubric) wired to `smithers eval` | — | optional | new |
| **context-doctor** | quality | deterministic checks over a context contract (mirror workflow doctor) | CLI verb + workflow | optional | new |
| **monitor-smithers** | ops | watchdog over runs: detect stuck/blocked/failed/long; classify; escalate | Poller, EscalationChain, cron | ✅ yes | new (**user-requested**) |
| **triage-run** | ops | one failed/stuck run → pull events/logs/traces → root-cause → fix/rewind/retry | dispatched by monitor-smithers | optional | new |
| **report-slideshow** | ops | run state → HTML slideshow report | reuses `capture:slideshow` | (component) | new |

### 1a. `context-engineer` (flagship)

The proxy. Already drafted in research; Smithers shape:

```
context-engineer
  ├─ classify-script          (cheapFast) → modes[] + single-task|durable
  ├─ inventory-context        (smartTool) → initial context contract (repo/tools/skills/memory scan)
  ├─ grill-until-clear        (GrillMe component, maxIterations≈30) → resolve blocking ambiguity, one Q at a time, recommended answers
  ├─ route                    (smart) → smallest sufficient route (skills + workflow)
  ├─ build-backpressure       (smart) → gate matrix; workflow not "ready" until every blocking criterion has a verification method
  ├─ approve-contract         (Approval) → human signs off on contract + route + gates
  ├─ execute                  (Ralph until gates pass) → run chosen sub-workflow / artifacts; revise context|harness on repeated failure
  ├─ report                   (report-slideshow component) → HTML slideshow from run state
  └─ extract                  (extract-skill, optional) → propose reusable skill/workflow + memory
```

Key invariants (the "backpressure" thesis, enforced in prompts + schema):
- never ask what's discoverable from repo/docs/tools/memory (grill-me rule);
- every ambiguity → assumption | question | deferred decision;
- every success criterion → ≥1 verification signal;
- structured outputs wherever a downstream step depends on the result;
- one-shot work is NOT over-orchestrated (route-task short-circuits).

`route-task` is the degenerate context-engineer for the common "just run one
task" case — it exists so the concierge has a cheap path and so a single task is
still a first-class outcome, not a failure to find a workflow.

### 1b. `monitor-smithers` (user-requested)

A watchdog for Smithers itself — the SRE layer.

```
monitor-smithers (cron or long-running, --serve)
  ├─ poll            → smithers ps / events (active|paused|recent)
  ├─ classify        → {healthy | stuck (no heartbeat) | blocked (approval/signal waiting) | failed | over-budget | long-running}
  ├─ branch
  │    ├─ blocked    → surface the pending approval/question (smithers why) → human/HumanTask
  │    ├─ stuck/failed → dispatch triage-run → root-cause → propose fix/rewind/retry (gated)
  │    └─ over-budget → alert + pause (Aspects budget breach)
  └─ digest          → periodic legible status (and optional report-slideshow)
```

Ships with a `smithers cron` schedule preset. Pairs with `triage-run` (the
single-run deep-dive) so monitor stays cheap and fans out only on anomalies.

---

## 2. Skills

| Skill | Action | Notes |
|---|---|---|
| `skills/smithers/SKILL.md` | **update** | Add the layered-control-system framing, a "Concierge / proxy" section, a "Backpressure" section, and references to the new workflows. Correct attributions (Matt Pocock = grill-me/AI Hero; Dex Horthy = HumanLayer/harness eng). |
| `skills/context-engineer/SKILL.md` | **new** | Refine the research draft; point it at the `context-engineer` workflow; keep the question/contract/backpressure schemas. This is the agent-facing operating manual for the concierge. |
| `skills/create-workflow/` | new | So agents reach for the authoring workflow. Can be auto-generated by the `workflow-skill` workflow. |
| `skills/monitor-smithers/` | new | Same; ops-facing. |
| `prompt-author`, `schema-author`, `eval-writer`, `report-maker`, `risk-reviewer` | new (small) | The **routing targets** the concierge installs/uses per question category (prompt design → prompt-author; structured output → schema-author/BAML-style; eval design → eval-writer; reporting → report-maker; secrets/actions → risk-reviewer). These are what `smithers skills add` provisions. |

Skills ship via `smithers skills add`; new skills must be registered wherever the
skills registry lives (skills/ dir + whatever init seeds). The `create-workflow`
**provision** step already installs needed skills — make `create-skill` the
authoring counterpart so the catalog can grow itself.

---

## 3. Docs

| Doc | Action |
|---|---|
| `docs/concepts/context-engineering.mdx` | **new** — the layered model + external refs (Anthropic evals, LangChain/LlamaIndex context eng, HumanLayer harness eng, BAML schema eng, Ralph). Position Smithers as the orchestration+backpressure layer. |
| `docs/concepts/backpressure.mdx` | **new** — the gate taxonomy (schema/test/eval/review/approval/trace/memory/cost/safety) mapped to Smithers primitives (Zod output, repoCommands tests, `smithers eval`, ReviewLoop, Approval, OTel traces, memory policy, Aspects budgets). |
| `docs/guides/authoring-workflows.mdx` | **new** — manual path + the `create-workflow` workflow path. |
| `docs/guides/concierge.mdx` | **new** — the `context-engineer` UX end-to-end (the non-expert flow). |
| `docs/llms.txt` + new `docs/llms-context.txt` | **update/new** — progressive-disclosure fragment for context-engineering so agents pull it on demand; list new workflows/components in `llms-core.txt`. |
| `docs/starters.mdx`, `docs/recipes.mdx` | **update** — add context-engineer, create-workflow, monitor-smithers. |

---

## 4. Wire into `smithers init` (hard requirement + the real fix)

**Mechanism (confirmed):** `smithers init` does NOT copy `.smithers/workflows/`.
`apps/cli/src/workflow-pack.js` (~4300 lines) hand-embeds the seeded pack as
escaped string-array literals:
- `DEFAULT_WORKFLOW_METADATA[id] = { description, tags }` (~L1580)
- `renderWorkflowFile(id, displayName, body[], metadata)` (~L1617) → emits
  `.smithers/workflows/<id>.tsx` with the seeded header comments
- prompts as `{ path: ".smithers/prompts/<id>.mdx", contents }` entries (e.g. L447, L812)
- a master `TemplateFile[]` written by the `writeFileSync` loop (~L4287)
- gateway-UI registration list (~L1660) — only for workflows with bespoke UIs
- separately, the **app store** catalog lives in `apps/smithers/src/store/workflows.ts`
  (`STORE_WORKFLOWS`) + `workflowDocs.ts` (`WORKFLOW_DOCS`, `runDoctor`)

So registering one workflow today means hand-escaping its `.tsx` + every `.mdx`
into a 4300-line file **and** updating 2–3 registries. That is the duplication
the user is hitting.

**Immediate (to satisfy the requirement now):** add `create-workflow` (+ its 6
prompts) and each shipped workflow to `workflow-pack.js`:
1. `DEFAULT_WORKFLOW_METADATA["create-workflow"] = { description, tags: ["authoring","workflow-pack"] }`
2. `renderWorkflowFile("create-workflow", "Create Workflow", [...body])` into the master files array
3. six prompt `{ path, contents }` entries for `create-workflow-*.mdx`
4. add to `apps/smithers/src/store/workflows.ts` `STORE_WORKFLOWS` (+ a `WORKFLOW_DOCS` entry so the doctor/launch UI works)
5. optional: next-steps CTA

**Strategic (recommended — do this instead of hand-embedding):** replace the
hand-embedded pack with a **generator**. `scripts/generate-workflow-pack.ts`
reads the canonical seeded files (`.smithers/workflows/*.tsx` +
`.smithers/prompts/*.mdx` marked `// smithers-source: seeded`) and emits the
`TemplateFile[]` (or imports them as raw string assets). Then:
- "add a workflow to init" = drop the file in `.smithers/workflows/` + run the generator;
- the source of truth is the dogfood pack itself (no escaping, no drift);
- `create-workflow`'s **scaffold** step can run the generator + add the `STORE_WORKFLOWS`
  entry, so **authoring a workflow auto-ships it to init and the store.**

This is the single highest-leverage infra change in this plan: it makes the whole
"grow the catalog" loop (create-workflow / create-skill / extract-skill)
self-serve instead of requiring a manual port each time.

---

## 5. `apps/smithers` — the Context-Engineering Console

Grounded in current code (seeded/deterministic; gateway client wired but store/chat
are seeded; chat streams via `/api/chat` Worker; `runDoctor`, `validateLaunch`,
`workflowToFlow`, `discoverInputs/Imports`, `getGatewayClient`, `streamReplyViaApi`
all exist; `capture:slideshow` script exists).

- **P0 — Ask Me → Context Contract Builder.** Extend `askme/grillMe.ts`
  `GRILL_SYSTEM_PROMPT` (already one-question + recommended-answer) to emit
  structured contract state, not just chat. New `src/context-engineer/`:
  `contextContract.ts`, `questionQueue.ts`, `contextDoctor.ts`, `workflowRouter.ts`,
  `backpressure.ts`, `reportPlan.ts`.
- **P1 — Workflow recommendation from Store.** Intent classifier scoring
  `STORE_WORKFLOWS` against the contract → "This looks like research + planning +
  implementation with approvals → recommend `research-plan-implement` + a
  `grill-me` intake + blocking eval gates." Actions: accept / edit / why /
  run-as-one-off / save-as-workflow.
- **P2 — Context Doctor.** Mirror `runDoctor(doc)` style against the contract:
  `hasGoal`, `hasOutputSpec`, `hasAcceptanceCriteria`,
  `allBlockingCriteriaHaveVerification`, `allRequiredInputsHaveSource`,
  `allSideEffectsHaveApproval`, `allWorkflowDepsHaveProducer`, `reportSpecExists`.
- **P3 — Wire contract → real run.** Contract → launch payload → `getGatewayClient()`
  → stream events into the existing timeline/runs/approvals/scores UIs; final
  report viewer reuses `capture:slideshow`.
- **P4 — Extraction surface.** UI for the `extract-skill` workflow (save repeated
  patterns as skill/workflow + memory).
- **Five persistent panels:** Script · Context Contract · Questions · Workflow · Evidence.
- **Command:** add a `concierge` command (or promote `askme`) in `commands.ts`.

The console is *optional* for v1: `context-engineer` runs as a durable workflow
driven from the CLI today. The UI is the trust/legibility layer on top.

---

## 6. Sequencing

1. **P0 (now):** finish `create-workflow` → init. Build `scripts/generate-workflow-pack.ts`
   (the generator) so create-workflow + future workflows ship without hand-embedding.
   Update `skills/smithers/SKILL.md` + add `docs/concepts/context-engineering.mdx`.
2. **P1:** `context-engineer` + `route-task` workflows (CLI-first, no UI needed) +
   `skills/context-engineer/SKILL.md` + `backpressure-plan` component +
   `report-slideshow`.
3. **P2:** the apps/smithers Console (P0–P3 above).
4. **P3:** ops — `monitor-smithers` + `triage-run` (+ cron preset).
5. **P4:** the reuse loop — `create-skill` + `extract-skill` + the routing-target
   skills (prompt-author / schema-author / eval-author / report-maker / risk-reviewer).

## 7. Open decision

The one strategic fork: **invest in the init-pack generator now (P0) vs.
hand-embed each workflow.** Recommendation: build the generator — every other item
in this plan adds workflows/skills, so the manual-port tax compounds. It also
turns `create-workflow` into a true "author → ships everywhere" loop.
