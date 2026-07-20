# orchestration-behavior

Does a weak model, grounded only in our shipped docs/skill, exhibit the
disciplines a **long-lived orchestrator** needs? These are behavioral cases:
the candidate is asked how it would proceed, and an opus judge grades whether the
answer shows the target discipline (not whether it compiles).

## Behaviors under test

| feature | the discipline | passes when |
| --- | --- | --- |
| `lifeline-context-protection` | The orchestrator is a long-lived lifeline; its context window is the scarce resource. | It fans a large read out to a disposable sub-agent that returns a summary/verdict instead of reading the diff into its own context. |
| `fan-out-judgment` | Judging best-of-N candidates is delegated, not done inline. | It spawns a fresh independent verifier/`Panel`/`ReviewLoop` to rank the candidates and acts on that verdict. |
| `anti-drift-reread` | Long sessions drift from their instructions. | Its periodic maintenance routine includes re-reading its own governing instructions/spec/goal and re-checking recent behavior against them. |

## Which docs this exercises

- `docs/guides/context-engineering.mdx` — the flagship doctrine (the lifeline rule
  + anti-drift re-read doctrine live here).
- `skills/smithers/SKILL.md` — the agent operating doctrine ("the levers you pull").
- `docs/guides/agent-operating-playbook.mdx` — orchestrator-not-implementer,
  fan-out verification.

## Before/after gate

Authored to start **red** against the docs as of 2026-07-06: the lifeline pattern
and the anti-drift re-read doctrine were unnamed/absent, so weak models don't
produce them. The docs change that names the "lifeline rule" and adds the
"re-read your instructions to fight drift" doctrine is what flips these green.

## Running

```bash
bun evals/harness/run-suite.ts orchestration-behavior --only-model haiku -j 2
```
