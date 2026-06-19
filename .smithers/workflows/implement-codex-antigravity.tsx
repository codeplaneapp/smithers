// smithers-source: user
// smithers-display-name: Implement Codex Antigravity
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema } from "../components/Review";

const inputSchema = z.object({
  prompt: z.string().default("Implement the requested change."),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
});

const codexAntigravityOnly = [providers.codex, providers.codex1, providers.antigravity1];

export default smithers((ctx) => {
  const validate = ctx.outputMaybe("validate", { nodeId: "impl:validate" });
  const reviews = ctx.outputs.review ?? [];

  const hasValidated = validate !== undefined;
  const validationPassed = hasValidated && validate.allPassed !== false;
  const anyApproved = reviews.length > 0 && reviews.some((r: any) => r.approved === true);
  const done = validationPassed && anyApproved;

  const feedbackParts: string[] = [];
  if (validate && !validationPassed && validate.failingSummary) {
    feedbackParts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
  }
  for (const review of reviews) {
    if (review.approved === false) {
      feedbackParts.push(`REVIEWER REJECTED:\n${review.feedback}`);
      if (review.issues?.length) {
        for (const issue of review.issues) {
          feedbackParts.push(`  [${issue.severity}] ${issue.title}: ${issue.description}${issue.file ? ` (${issue.file})` : ""}`);
        }
      }
    }
  }
  const feedback = feedbackParts.length > 0 ? feedbackParts.join("\n\n") : null;

  return (
    <Workflow name="implement-codex-antigravity">
      <ValidationLoop
        idPrefix="impl"
        prompt={ctx.input.prompt}
        implementAgents={codexAntigravityOnly}
        validateAgents={codexAntigravityOnly}
        reviewAgents={codexAntigravityOnly}
        feedback={feedback}
        done={done}
        maxIterations={3}
      />
    </Workflow>
  );
});
