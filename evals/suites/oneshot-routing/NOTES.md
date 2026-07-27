# oneshot-routing

Checks that an agent grounded in the shipped Smithers guidance chooses the
lightest correct route.

| ask | required route |
| --- | --- |
| Most-trivial edit | Direct by default; oneshot with opus or terra when stored preference says oneshot |
| Clear single-agent task | `smithers oneshot`, with Sol, Kimi, Fable, Opus preference order |
| Large single-goal task (repo-wide docs audit, dependency upgrade, CI-green, library migration, review burndown) | `smithers oneshot`; authoring a workflow is overengineering |
| Ambiguous task | Clarify before launching |
| Multi-stage or approval-gated task | Full Smithers workflow |
| No supported usable CLI | Do not offer oneshot |
| First use | Announcement, both preferences, recommendations, persistence, and override point |
| Explicit review override | Preserve the user's choice |

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

## Running

```bash
bun evals/harness/run-suite.ts oneshot-routing -j 4                 # full suite
bun evals/harness/run-suite.ts oneshot-routing --only-model haiku   # focused
```

Cases are seated on haiku/sonnet only: the matrix's gemini seat now runs
through Google's `agy` CLI (the Smithers GeminiAgent was sunset) and the kimi
seat needs live Kimi credentials; neither is guaranteed on a dev machine, and
a routing-guidance suite should never go red on agent-CLI infrastructure.
