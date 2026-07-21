# deliverable-behavior — notes

Does a weak model, grounded only in the shipped docs/skill, choose the right
**deliverable shape** without being told?

## Group A — HTML deliverables (judge verify)

A bare user request in a session with the Smithers skill installed should yield
a polished, self-contained **HTML page** as the deliverable — not chat
markdown. The gate is the *shape* only; content depth is advisory.

| taskId | user asks for |
| --- | --- |
| `html-deliverable-report` | a report (weekly changelog) |
| `html-deliverable-plan` | a plan (Jest→Vitest migration) |
| `html-deliverable-architecture` | an architecture document (notification system) |
| `html-deliverable-postmortem` | a postmortem (Redis failover outage) |
| `html-deliverable-research` | a research summary with a recommendation (Redis→Valkey) |
| `html-deliverable-rfc` | an RFC (splitting the billing module) |
| `html-deliverable-release-notes` | customer release notes (v2.4) |
| `html-deliverable-status` | an exec-forwardable status update (ERP migration) |
| `html-deliverable-runbook` | an on-call runbook (payment webhook failures) |

## Group B — unprompted shared-UI-element selection (build verify)

The task describes a workflow-UI *situation*; the shipped component that fits
is never named. The deterministic build gate requires the component's token;
the auto-attached ui-quality judge grades polish.

| taskId | situation | required shared component |
| --- | --- | --- |
| `ui-element-markdown-editor` | user edits a node's markdown doc, saves via signal | `MarkdownEditor` (`ui/adapters/markdown-editor`); raw `<textarea>` auto-fails |
| `ui-element-diff-hunks` | render a review node's DiffBundle | `DiffHunks` |
| `ui-element-chat-surface` | conversational workflow: transcript + reply box | `ChatTranscript`, `ChatComposer` |
| `ui-element-run-overview` | all-runs overview: counts, statuses, zero state | `KpiStat`, `StatusPill`, `EmptyState` |
| `ui-element-approval-panel` | approve/deny the run's pending gates | `ApprovalPanel` |
| `ui-element-launch-button` | kick off a new run one-click | `LaunchButton` |
| `ui-element-run-event-log` | live auto-following event stream | `RunEventLog` |
| `ui-element-run-tree` | execution structure as expandable tree | `RunTree` |
| `ui-element-node-output-view` | one node's typed output, formatted | `NodeOutputView` |
| `ui-element-workflow-picker` | choose a workflow in the UI first | `WorkflowPicker` |
| `ui-element-terminal` | raw ANSI shell output, live | `Terminal` (`ui/adapters/terminal`) |
| `ui-element-stage-strip` | position in a fixed stage pipeline | `StageStrip` |
| `ui-element-file-tree` | changed paths as a collapsible tree | `FileTree` |
| `ui-element-release-chart` | release-range totals + per-area commits, visually | `ChartContainer` (`ui/adapters/chart`), `KpiStat`; `<canvas>`/chart.js auto-fail |

Group A also carries `release-notes-visual-report`: "explain the changes in the
release from commit A to commit B, use visuals" must yield a self-contained
HTML report whose judge gates COVERAGE (every area + every named fix from the
context), GRAPHICS (two or more real charts whose mark geometry encodes the
supplied numbers — icons/tables alone do not count), CHART HONESTY (no
dual-axis, labels or a legend, values readable as text), and the
self-contained-HTML shape.

## Model matrix reality (2026-07-20)

Canonical cases run **haiku + sonnet** (48 cases; 44 at the 2026-07-20
baseline, +4 release-notes-visual cases added 2026-07-21). The wider matrix is
blocked:

- **gemini** — the Gemini CLI is **sunset in Smithers** (preflight fails
  everywhere, not just locally). `evals/agents.ts` still lists it; other suites'
  gemini cases fail for the same reason. Dropping it from the matrix is a
  separate, repo-wide fix.
- **kimi** — the `~/.smithers/accounts/kimi-1` account's sessions error out
  ("Kimi session … is broken") on every case. Re-add kimi cases once the
  account is healthy.
- **codex** — used as the validation vehicle while the Claude 5-hour quota was
  exhausted; 22/22 (see below).

## Results timeline

1. **7-task suite, no doctrine: 1/14.** Candidates produced Markdown and
   hand-rolled `<textarea>`/diff/chat UIs.
2. **+SKILL.md doctrine & component table: 2/14.** Load-bearing finding:
   candidates saw a report/plan ask and concluded "no connection to Smithers,"
   never opening the skill. Fixed two-sided: cases state the skill's standing
   rules govern every deliverable; the skill frontmatter `description` now
   claims deliverable shape so it *triggers* on such asks.
3. **Original 7 tasks: 14/14.**
4. **Expanded to 22 tasks (haiku): 13/22** (3 quota-blocked). Friction theme:
   "no documentation on what built-in components are available" — the table
   covered `ui` primitives but not `gateway-ui` widgets. Table extended;
   postmortem/RFC/runbook/etc. named in the doctrine.
5. **Codex validation, pre contract-fix: 9–11/22, high variance.** Two real
   bugs surfaced:
   - **eval-kit's build contract steered candidates to hooks only** ("import
     the gateway hooks from gateway-react"), suppressing widget use across
     every build case in every suite. Contract now lists all three layers
     (gateway-ui widgets, ui primitives, gateway-react hooks) with
     "hand-rolled version of a shipped component is a wrong answer."
   - **Two cases over-specified beyond the shipped component** (approval
     "with a note"; "who asked, when" — ApprovalPanel renders neither).
     Candidates correctly reported the mismatch and hand-rolled. Tasks fixed
     to specify only what the widget does.
6. **Codex: 22/22.**
7. **2026-07-20 late: a concurrent jj session wiped this suite's untracked
   files and the eval-kit contract fix** (SKILL.md edits survived, absorbed
   into a commit). Suite recreated from the generator; contract fix re-applied.
8. **haiku/sonnet legs (post-quota): 14/22 and 18/22.** Friction mining found
   one more real doctrine conflict — sonnet read "write me a plan/runbook" as
   the *workflow* meanings ("Smithers is your plan mode", the `<Runbook>`
   pattern), not documents. SKILL.md gained the disambiguation: documents the
   human reads are HTML; workflows are for steps the machine executes. All
   Group A cases flipped green on re-run. The `node-output-view` task
   over-specified live refresh (docs said "fetched on demand") — task softened
   and `docs/reference/gateway-ui.mdx` corrected (NodeOutputView shows pending
   → output and updates; bundles regenerated).
9. **Final: haiku 20/22, sonnet 21/22, codex 22/22.** The two stragglers
   (`node-output-view` haiku, `run-overview` sonnet missing `StatusPill`) are
   weak-model retrieval noise against adequate docs — the component is named in
   the eval contract, the skill table, and llms-full with a worked example.
   Left RED deliberately: single-model misses against good docs are the
   scorecard's honest signal, not another doc patch.

## Case-authoring lessons (both caught by candidate friction)

- Eval task text must model **correct** APIs — a wrong `submitSignal({ name })`
  shape in the first draft manufactured `wrong-docs` friction in every case.
- Eval tasks must not demand **more than the shipped component does** — that
  teaches candidates to hand-roll, the exact behavior under test.

## Running

```bash
bun evals/harness/run-suite.ts deliverable-behavior                    # full suite (48)
bun evals/harness/run-suite.ts deliverable-behavior --only-model haiku # one leg
bun evals/harness/run-suite.ts deliverable-behavior --dry-run          # shape check
```
