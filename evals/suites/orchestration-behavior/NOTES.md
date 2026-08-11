# orchestration-behavior

Does a weak model, grounded only in our shipped docs/skill, exhibit the
disciplines a **long-lived orchestrator** needs? These are behavioral cases:
the candidate is asked how it would proceed, and an opus judge grades whether the
answer shows the target discipline (not whether it compiles).

## Behaviors under test

| feature                       | the discipline                                                                        | passes when                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lifeline-context-protection` | The orchestrator is a long-lived lifeline; its context window is the scarce resource. | It fans a large read out to a disposable sub-agent that returns a summary/verdict instead of reading the diff into its own context.                                                                                 |
| `fan-out-judgment`            | Judging best-of-N candidates is delegated, not done inline.                           | It spawns a fresh independent verifier/`Panel`/`ReviewLoop` to rank the candidates and acts on that verdict.                                                                                                        |
| `anti-drift-reread`           | Long sessions drift from their instructions.                                          | Its periodic maintenance routine includes re-reading its own governing instructions/spec/goal and re-checking recent behavior against them.                                                                         |
| `repair-loop-termination`     | A fix/verify loop must converge or stop; it must never grind.                         | It applies the shipped repair-loop discipline — same-signature circuit breaker, green ratchet, never widen a red gate, classify red before repairing, iterate inside one workflow, keep local diagnostics readable. |

## Repair-loop termination (`metadata.source: issue-1433`)

Filed by @samgbafa in
[#1433](https://github.com/smithersai/smithers/issues/1433): a 10-day loop that
authored 183 near-duplicate `.tsx` workflows across ~250 runs and 110 hours of
wall clock, and recorded exactly one green verdict — which was itself a truncated
stream. @roninjin10's reply on that thread landed the brakes
(`1ecbe64754`, `00422450a8`, `e9e746bbff`) and asked for the E1–E9 scenarios to be
encoded as a suite. These cases cover all nine: E8 and E9 share one case because
zero-context rounds and file-per-attempt authoring are the same lost-memory
failure in this trace; E7 records the independent-harness contract that the
thread identifies as doctrine-only today.

| case                                      | issue scenario | the failure it would have caught                                                                                                                |
| ----------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `repair-loop-circuit-breaker--sonnet`     | E3             | 13 rounds against one `/delegate` HTTP 500, three consecutive reviewer rejections for the same reason, no round budget and no escalation        |
| `repair-loop-no-widen-red-gate--haiku`    | E1             | the acceptance gate growing from 6 booleans (07-23) to 10 (07-26) while it was never green                                                      |
| `repair-loop-green-ratchet--haiku`        | E2             | `bearerPassed` flipping true → false after a harness-only rebuild, unremarked                                                                   |
| `repair-loop-classify-red--sonnet`        | classify-red   | harness deaths grading byte-identical to product failures, and reviewers minting `approved: false` from a truncated stream instead of `blocked` |
| `repair-loop-harness-only-rounds--sonnet` | E6             | successive rounds adding only loopback/test-infrastructure seams while the product proof never ran                                              |
| `repair-loop-independent-gate--sonnet`    | E7             | an implementer-authored all-green artifact contradicting the independent review's rejection                                                     |
| `repair-loop-one-workflow--sonnet`        | E8 + E9        | 183 hand-authored near-duplicate scripts with `noSessionPersistence`, re-feeding 23M tokens of the same context per round                       |
| `repair-loop-fenced-root-cause--haiku`    | E5             | the likely root cause (a missing single-flight in `activateSessionWithHost`) sitting in the one repo the loop was fenced out of                 |
| `repair-loop-local-diagnostics--sonnet`   | E4             | 13 rounds diagnosing a 500 by the byte length of its response body, because the loop redacted its own local output                              |

## Which docs this exercises

- `docs/guides/context-engineering.mdx` — the flagship doctrine (the lifeline rule
  - anti-drift re-read doctrine live here).
- `skills/smithers/SKILL.md` — the agent operating doctrine ("the levers you pull").
- `docs/guides/agent-operating-playbook.mdx` — orchestrator-not-implementer,
  fan-out verification.
- `skills/smithers/SKILL.md` § "Repair-loop discipline" and
  `skills/eval-driven-development/SKILL.md` § "Discipline rules" — the
  same-signature budget, green ratchet, never-widen-a-red-gate,
  classify-red-before-repairing, one-workflow iteration, and readable local
  diagnostics rules the `repair-loop-*` cases grade against.

## Before/after gate

Authored to start **red** against the docs as of 2026-07-06: the lifeline pattern
and the anti-drift re-read doctrine were unnamed/absent, so weak models don't
produce them. The docs change that names the "lifeline rule" and adds the
"re-read your instructions to fight drift" doctrine is what flips these green.

## Running

```bash
bun evals/harness/run-suite.ts orchestration-behavior --only-model haiku -j 2
```
