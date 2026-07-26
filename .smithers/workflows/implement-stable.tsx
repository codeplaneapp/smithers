// smithers-source: user
// smithers-display-name: Implement Stable
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Task } from "smithers-orchestrator";
import { z } from "zod/v4";
import { implementer, panelists, synthesizer, validator } from "../components/roles";
import {
  ValidationLoop,
  implementOutputSchema,
  validateOutputSchema,
  validationLoopState,
} from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema } from "../components/Review";

export const inputSchema = z.object({
  prompt: z.string().trim().min(1).max(100_000).default("Implement the requested change."),
  maxIterations: z.number().int().min(1).max(10).default(3),
});
const failureSchema = z.object({ error: z.string() });

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
  failure: failureSchema,
});

const implementAgents = implementer;
const validateAgents = validator;
const reviewAgents = panelists;

export default smithers((ctx) => {
  const prompt = ctx.input.prompt ?? "Implement the requested change.";
  const maxIterations = ctx.input.maxIterations ?? 3;
  const state = validationLoopState(ctx, { prefix: "impl", maxIterations });

  return (
    <Workflow name="implement-stable">
      <Sequence>
        <ValidationLoop
          idPrefix="impl"
          prompt={prompt}
          implementAgents={implementAgents}
          validateAgents={validateAgents}
          reviewAgents={reviewAgents}
          synthesizeReview
          reviewModerator={synthesizer}
          reviewWhen={state.validationPassed}
          feedback={state.feedback}
          done={state.done}
          maxIterations={maxIterations}
        />
        {state.exhausted ? (
          <Task id="impl:exhausted" output={outputs.failure} retries={0}>
            {() => {
              throw new Error(`Implement Stable exhausted after ${maxIterations} attempts`);
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
