// smithers-source: user
// smithers-display-name: Debug
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers, Sequence, Task } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema } from "../components/Review";

const inputSchema = z.object({
  prompt: z.string().default("Reproduce and fix the reported bug."),
});

const terminalSchema = z.object({
  completed: z.boolean(),
  exhausted: z.boolean(),
  iterations: z.number().int().nonnegative(),
  validationPassed: z.boolean(),
  reviewApproved: z.boolean(),
  summary: z.string(),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  output: terminalSchema,
});

export default smithers((ctx) => {
  const prefix = "debug";
  const validate = ctx.latest("validate", `${prefix}:validate`) as
    | { allPassed?: boolean; failingSummary?: string | null }
    | undefined;
  const review = ctx.latest("review", `${prefix}:review:0`) as { approved?: boolean; feedback?: string } | undefined;
  const validateRounds = ctx.iterationCount("validate", `${prefix}:validate`);
  const reviewRounds = ctx.iterationCount("review", `${prefix}:review:0`);
  const latestRaw = (rows: unknown[] | undefined) =>
    rows?.filter((row): row is Record<string, unknown> => Boolean(row)).at(-1);
  const paired =
    validateRounds === reviewRounds &&
    validateRounds > 0 &&
    latestRaw(ctx.outputs.validate)?.iteration === latestRaw(ctx.outputs.review)?.iteration;
  const validationPassed = paired && validate?.allPassed !== false;
  const reviewApproved = paired && review?.approved === true;
  const completed = validationPassed && reviewApproved;
  const iterations = (ctx.outputs.implement ?? []).length;
  const exhausted = !completed && iterations >= 3;
  const feedback =
    [
      validate?.allPassed === false && validate.failingSummary ? `VALIDATION FAILED:\n${validate.failingSummary}` : "",
      paired && review?.approved === false && review.feedback ? `REVIEW REJECTED:\n${review.feedback}` : "",
    ]
      .filter(Boolean)
      .join("\n\n") || null;
  return (
    <Workflow name="debug">
      <UI entry="../ui/debug.tsx" title={"Debug"} />
      <Sequence>
        <ValidationLoop
          idPrefix={prefix}
          prompt={ctx.input.prompt}
          implementAgents={agents.implement}
          validateAgents={agents.midTier}
          reviewAgents={[agents.review]}
          feedback={feedback}
          done={completed}
          maxIterations={3}
        />
        {completed || exhausted ? (
          <Task id="debug:output" output={outputs.output}>
            {() => ({
              completed,
              exhausted,
              iterations,
              validationPassed,
              reviewApproved,
              summary: completed
                ? (review?.feedback ?? "debug completed")
                : (validate?.failingSummary ?? review?.feedback ?? "debug exhausted"),
            })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
