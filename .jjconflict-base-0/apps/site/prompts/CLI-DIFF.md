# Generated vs hand-written CLI reference pages

Three verbs were written twice: by hand under
`apps/site/src/content/docs/docs/reference/cli/<verb>.mdx` (the other docs
agent, from the brief) and by the reference pipeline under
`packages/smithers/docs/reference/cli/<verb>.md` (prompt
`apps/site/prompts/reference-cli-verb.md`, inputs `packages/smithers/src/**`,
the README, and the `apps/site/src/data/help/<verb>.txt` captures, with the
hand-written pages withheld from the writer). This report compares them so
one source per route can be chosen. Every claim below was checked against
`packages/smithers/src/Command.ts` after both were written.

## Where the two disagree on a fact

| Verb | Hand-written page | Generated page | Source |
| --- | --- | --- | --- |
| `plan` | `flow` argument is `Required: yes`. | `FLOW_ID` is `Required: No`; an omitted id reaches the control plane as `""`. | `Command.ts:88` registers one variadic `key=value...` argument and `Command.ts:478` reads `config.input[0] ?? ""`. The generated page is right; `--help` (`plan.txt`) also never names the flow id, a parser defect. |
| `plan`, `run`, `up` | `--remote <url>` is listed as a verb flag. | `--remote` is a global flag, listed once under "Global flags" with the other six. | `Command.ts:54-82`: `remote` sits in the shared `global` flag set applied by `Command.withSharedFlags`. Both are true statements; the generated placement matches the parser. |
| `plan` | Exit codes 0, 1, 2. | Exit codes 0, 1, 2, 130, 143, and 1 for `--backend`/`SMITHERS_BACKEND` other than `sqlite`. | `bin.ts:23-34, 86-96` (signals), `Command.ts:83` (`--backend`). The generated table is complete for the codes this verb can produce. |
| `run` | Exit 1 quotes `ClaimLost: claim_lost runId=<run-id>`; exit 2 quotes `run requires a plan approval payload`. | Structural descriptions; no quoted strings. | Both strings are source-pinned (`Command.ts:520`, `control/src/ControlError.ts:113`); the generated writer missed them. The exit-2 message was added to the generated `run` page after this check; the `claim_lost` rendering still needs the line that formats it. |
| `run` | Two argument rows (`plan-payload`, `run-id`). | One row (`PLAN_PAYLOAD`) noting that `--resume` reads the same position as a run id. | `Command.ts:538-541`: one positional `plan-payload`, one boolean `--resume`; the `resume` alias command takes `run-id`. Both renderings are defensible; the generated one mirrors the registration. |
| `up` | Synopsis `smithers up <flow> [--data <json>] [-d]`. | Synopsis `smithers up FLOW_ID [--data JSON] [--detached]`. | Style only: the generated page uses the Google command-line notation the rubric fixes (`UPPER_SNAKE`, `[optional]`). |
| all three | No note on `--quiet`. | `<!-- verify: -->` on `--quiet`: the flag's description promises stderr-only suppression, but `render` (`Command.ts:229-244`) also skips the stdout document. | Real code/description disagreement; a parser or description fix, and the page should say what the code does until then. |

No fact on the generated pages was found to be wrong, and the generated
writer under-quoted two source-pinned strings. One fact on the hand-written
pages is wrong: `plan`'s flow id is not required by the parser.

## Where the two differ in shape

- The hand-written pages carry a `## Output` section that lists the printed
  document's fields (`planId`, `flowId`, `digest`, `nodes`, `approval` for
  `plan`; the `Accepted`, `Parked`, `Terminal`, `AlreadyApplied`, `Conflict`
  receipt kinds for `run`). The generated pages describe output structurally
  and do not table the fields. The hand-written field tables are the better
  reference content; the generated prompt should require them, sourced from
  `Output.ts` and the control schema.
- The hand-written pages link to guides and MCP tools in the route map; the
  generated pages link only to sibling verbs and the guide the prompt names.
- The hand-written pages import the `--help` capture with `?raw` into a
  `<Code>` block; the generated pages quote the synopsis in the four-notation
  form and leave the capture out. Embedding the capture is worth adding to
  the ingest for the `cli` area, since it cannot drift.
- Lengths: hand-written 82, 78, 75 lines; generated 154, 124, 138 lines. The
  extra length is the global-flags section, the fuller exit-code tables, the
  `## Sources` list, and the description paragraphs on what the verb never
  does.

## Recommendation

Keep the generated page as the source of record for the fact tables
(arguments, flags, exit codes) and fold the two hand-written strengths into
the CLI prompt: the output field table and the `?raw` help embed. Then point
the ingest at `reference/cli/` and retire the hand-written copies, or keep the
hand-written copies and fix the `plan` argument row by hand. Either way, one
writer per route; today there are two.

## Commands

```bash
# regenerate one verb page (spawns the writer agent)
pnpm exec smithers-build target //packages/smithers:referenceCliPlan --write
# compare
diff <(sed -n '/^## Flags/,/^## /p' packages/smithers/docs/reference/cli/plan.md) \
     <(sed -n '/^## Flags/,/^## /p' apps/site/src/content/docs/docs/reference/cli/plan.mdx)
```
