# oneshot-routing

Checks that an agent grounded in the shipped Smithers guidance chooses the
lightest correct route.

| ask                                                                                                             | required route                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Most-trivial edit                                                                                               | Direct by default; oneshot with opus or terra when stored preference says oneshot                                                                                  |
| Clear single-agent task                                                                                         | `smithers oneshot`, task-shaped: UI goals lead with kimi (opencode, then pi, then the kimi CLI, backed by claude opus or fable), other goals lead with claude opus |
| Large single-goal task (repo-wide docs audit, dependency upgrade, CI-green, library migration, review burndown) | `smithers oneshot`; authoring a workflow is overengineering                                                                                                        |
| Ambiguous task                                                                                                  | Clarify before launching                                                                                                                                           |
| Multi-stage or approval-gated task                                                                              | Full Smithers workflow                                                                                                                                             |
| No supported usable CLI                                                                                         | Do not offer oneshot                                                                                                                                               |
| First use                                                                                                       | Announcement, both preferences, recommendations, persistence, and override point                                                                                   |
| Explicit review override                                                                                        | Preserve the user's choice                                                                                                                                         |

These cases were RED before the oneshot routing section was added to
`skills/smithers/SKILL.md`. They are GREEN when all three tiers and the first-run
contract are followed.

The `large-*` cases (`metadata.source: real-goal-prompts`) are real `/goal`
prompts mined from the maintainer's Codex history (`~/.codex/history.jsonl`).
Each was one-shotted by one strong agent at a pinned commit in under 300k
tokens, which is why the required route is a single `smithers oneshot` launch:
they pin the anti-overengineering behavior, where "the task feels big" must not
push a single-goal ask into workflow authoring. They were RED before the skill
carried the roughly-300k scale claim and the "size does not pick the route;
shape does" rule (also pinned by
`apps/cli/tests/smithers-skill-contract.test.js`).

## Scope control (`metadata.source: issue-1444`)

Filed by @0xpolarzero in
[#1444](https://github.com/smithersai/smithers/issues/1444): a 14-day audit found
39 runs with a recorded span of at least an hour, 28 of them the default
`implement` shape, and the focused one-fixture asks got the same three-pass
implementation/validation/review loop as the program-scale ones.

| case                                  | the failure it would have caught                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `scoped-fix-stays-small--sonnet`      | `run-1784797351166` / `run-1784831004426` — a one-assertion or one-fixture fix routed into `implement`'s ValidationLoop                 |
| `emphasis-words-no-escalation--haiku` | "full" / "complete" / "verify" in a scoped file-and-test ask escalating it to a mission                                                 |
| `retry-cost-budget--sonnet`           | `run-1784868859489` — 46 attempts, 45 of them 30-minute CLI timeouts, resuming the same agent and session inside an un-reached loop cap |
| `topology-budget-preflight--sonnet`   | `run-1784647151549` — a 585-line generated workflow launched with no declared node/attempt/wall budget                                  |

## Phase control (`metadata.source: issue-1445`)

Filed by @aviggiano in
[#1445](https://github.com/smithersai/smithers/issues/1445), with a complete
session trace. A prompt ending "propose a plan, then ask me questions … until we
have agreed on next steps" must yield a concise plan plus questions and nothing
else.

| case                                    | the failure it would have caught                                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan-only-no-launch--sonnet`           | the phase-control contract: a plan-only turn must not start a new run or generate a workflow before agreement; the trace's later builder/finalizer runs happened only after explicit approval |
| `plan-only-no-artifact--haiku`          | the same turn writing a standalone 26,911-character HTML plan artifact                                                                                                                        |
| `plan-only-prior-run-isolation--sonnet` | the same turn retrying and resuming an unrelated prior `implement` run twice                                                                                                                  |

## Running

```bash
bun evals/harness/run-suite.ts oneshot-routing -j 4                 # full suite
bun evals/harness/run-suite.ts oneshot-routing --only-model haiku   # focused
```

Cases are seated on haiku/sonnet only: the matrix's gemini seat now runs
through Google's `agy` CLI (the Smithers GeminiAgent was sunset) and the kimi
seat needs live Kimi credentials; neither is guaranteed on a dev machine, and
a routing-guidance suite should never go red on agent-CLI infrastructure.
