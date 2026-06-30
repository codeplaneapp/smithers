// smithers-source: user
// smithers-display-name: Implement Stable
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema, reviewGate } from "../components/Review";

const inputSchema = z.object({
  prompt: z.string().default("Implement the requested change."),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
});

const implementAgents = [providers.claude, providers.antigravity1];
const validateAgents = [providers.claudeSonnet, providers.antigravity1];
const reviewAgents = [providers.claude, providers.antigravity1];

export default smithers((ctx) => {
  const validate = ctx.outputMaybe("validate", { nodeId: "impl:validate" });

  const hasValidated = validate !== undefined;
  const validationPassed = hasValidated && validate.allPassed !== false;
  const gate = reviewGate(ctx, "impl:review-moderator");
  const done = validationPassed && gate.approved;

  const feedbackParts: string[] = [];
  if (validate && !validationPassed && validate.failingSummary) {
    feedbackParts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
  }
  if (gate.feedback) {
    feedbackParts.push(`REVIEW PANEL REJECTED:\n${gate.feedback}`);
  }
  const feedback = feedbackParts.length > 0 ? feedbackParts.join("\n\n") : null;

  return (
    <Workflow name="implement-stable">
      <ValidationLoop
        idPrefix="impl"
        prompt={ctx.input.prompt}
        implementAgents={implementAgents}
        validateAgents={validateAgents}
        reviewAgents={reviewAgents}
        synthesizeReview
        reviewModerator={providers.claude}
        feedback={feedback}
        done={done}
        maxIterations={3}
      />
    </Workflow>
  );
});
