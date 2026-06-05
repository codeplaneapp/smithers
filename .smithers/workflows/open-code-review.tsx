// smithers-source: authored
// smithers-display-name: Open Code Review
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence } from "smithers-orchestrator";
import {
  openCodeReviewInputSchema,
  normalizeOpenCodeReviewInput,
  previewOpenCodeReview,
  previewOutputSchema,
  resolveReviewTarget,
  reviewRunOutputSchema,
  reviewTargetSchema,
  runOpenCodeReview,
  workflowSummarySchema,
} from "../lib/open-code-review";

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: openCodeReviewInputSchema,
  target: reviewTargetSchema,
  preview: previewOutputSchema,
  review: reviewRunOutputSchema,
  summary: workflowSummarySchema,
});

export default smithers((ctx) => {
  const input = normalizeOpenCodeReviewInput(ctx.input);
  return (
    <Workflow name="open-code-review">
      <Sequence>
        <Task id="resolve-target" output={outputs.target} noRetry>
          {async () => resolveReviewTarget(input)}
        </Task>

        <Task id="preview" output={outputs.preview} noRetry>
          {async () => previewOpenCodeReview(input)}
        </Task>

        <Task id="review" output={outputs.review} timeoutMs={(input.timeout + 3) * 60_000} noRetry>
          {async () => {
            const preview = ctx.outputMaybe(outputs.preview, { nodeId: "preview" });
            if (!preview) throw new Error("preview did not complete");
            return runOpenCodeReview(input, preview);
          }}
        </Task>

        <Task
          id="summary"
          output={outputs.summary}
          noRetry
        >
          {() => {
            const target = ctx.outputMaybe(outputs.target, { nodeId: "resolve-target" });
            const preview = ctx.outputMaybe(outputs.preview, { nodeId: "preview" });
            const review = ctx.outputMaybe(outputs.review, { nodeId: "review" });
            if (!target) throw new Error("target did not complete");
            if (!preview) throw new Error("preview did not complete");
            if (!review) throw new Error("review did not complete");
            return {
              status: review.status,
              repoDir: target.repoDir,
              mode: target.mode,
              reviewableFiles: preview.reviewableCount,
              excludedFiles: preview.excludedCount,
              comments: review.comments.length,
              warnings: review.warnings.length,
              totalTokens: review.summary?.totalTokens ?? 0,
              message:
                review.message ||
                (review.ok
                  ? `Reviewed ${preview.reviewableCount} file(s) and produced ${review.comments.length} comment(s).`
                  : review.error || "OpenCodeReview failed."),
            };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
