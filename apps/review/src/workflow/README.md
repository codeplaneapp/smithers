# workflow/

The review workflow itself: four durable rounds on `@smthrs/flow` plus the
pure functions they call.

## The rounds

`reviewFlow.ts` declares them.

| Round | What it does |
| --- | --- |
| `Review` | Runs `PrepareReview`, then hands off. |
| `ReviewFiles` | Fans out over the discovered files in `concurrency`-wide batches, folds each batch into an accumulator, finalizes. |
| `VerifyReview` | Adjudicates the findings, applies the verdicts. |
| `NarrateReview` | Narrates, quizzes, renders and writes the walkthrough. |

Why four and not one: `Node.all` fixes its width when the graph is built, and
the file list a review fans out over is something the first step discovers.
`Flow.to` ends a round and starts the next one with its payload decoded as real
data, which is what lets `ReviewFiles` read `prepared.prompt.files` and build one
node per file. Verification is its own round for the same reason — whether to
narrate and quiz is decided from the POST-verification findings, and those do
not exist until the verifying round has settled.

## The parts

- `reviewActions.ts` — the non-model steps: `PrepareReview` (one step, because
  all four git reads must see the same working tree at the same instant),
  `MergeFileBatch`, `FinalizeReview`, `ApplyVerdicts`, `RenderWalkthrough`.
- `reviewAgentActions.ts` — the model steps: `ReviewFile`, `VerifyFindings`,
  `NarrateChanges`, `QuizChanges`. Each declares its `output` schema, which the
  agent boundary renders into the run's system teaching and enforces on the way
  back with one correction re-prompt.
- `reviewSeats.ts` — which `provider:model` string each logical seat maps to.
  The flow declares logical seats (`review`, `review-verify`, …) so a step
  identity does not move when the model behind it changes.
- `reviewSeatResolver.ts` — the only file that reads a credential. It turns a
  logical seat into a live provider route, and honours `ANTHROPIC_BASE_URL` so
  the metered proxy the GitHub Action runs behind still works.
- `reviewLayer.ts` — the shared declarations and `layerMemory` for tests and
  the eval; `reviewLayerNode.ts` — `layerNode` for a real run over a SQLite
  file, apart because importing the Node runtime opens `node:sqlite`.
- `reviewSchemas.ts` — what each round hands the next. A later round reads only
  what it was handed: re-running `git diff` in the last round would read a
  working tree that may have moved under the run.
- Verification: `verifyFindings.ts` builds the prompt,
  `verifyVerdictsSchema.ts` defaults `index` to -1 so a verdict that lost its
  index is ignored rather than silently targeting finding 0, and
  `applyFindingVerdicts.ts` applies keep/drop/demote (demote never raises
  severity).
- Input: `reviewInputSchema.ts` extends the open-code-review schema;
  `normalizeReviewInput.ts` strips nulls so a caller that spells "not supplied"
  as `null` gets the declared defaults.

## Failure is data

Every model step is wrapped in `Node.catch`. A file review that fails becomes a
`subtask_error` warning against that file, a verifier that fails leaves the
findings unverified with a `verifier_error` warning, and a narrator that fails
falls back to the deterministic story. 0.x spelled all three `continueOnFail`.
