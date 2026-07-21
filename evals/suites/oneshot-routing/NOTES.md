# oneshot-routing

Checks that an agent grounded in the shipped Smithers guidance chooses the
lightest correct route.

| ask | required route |
| --- | --- |
| Most-trivial edit | Direct by default; oneshot with opus or terra when stored preference says oneshot |
| Clear single-agent task | `smithers oneshot`, with Sol, Kimi, Fable, Opus preference order |
| Ambiguous task | Clarify before launching |
| Multi-stage or approval-gated task | Full Smithers workflow |
| No supported usable CLI | Do not offer oneshot |
| First use | Announcement, both preferences, recommendations, persistence, and override point |
| Explicit review override | Preserve the user's choice |

These cases were RED before the oneshot routing section was added to
`skills/smithers/SKILL.md`. They are GREEN when all three tiers and the first-run
contract are followed.

## Running

```bash
bun evals/harness/run-suite.ts oneshot-routing --only-model haiku -j 2
```
