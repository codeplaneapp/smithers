/**
 * The review workflow, as four durable rounds.
 *
 * `Node.all` fixes its width at plan time, and the file list a review fans out
 * over is something the first step discovers. That is what the rounds are for:
 * `Flow.to` ends a round and starts the next one with its payload as REAL
 * data, so the second round's body can read `prepared.prompt.files` and build
 * one node per file. Verification gets a round of its own for the same reason —
 * whether to narrate and quiz is decided from the POST-verification findings,
 * which do not exist until the verifying round has settled.
 *
 * Round 1 `Review`          prepare, then hand off
 * Round 2 `ReviewFiles`     fan out over the files in bounded batches, finalize
 * Round 3 `VerifyReview`    adjudicate the findings
 * Round 4 `NarrateReview`   narrate, quiz, render the walkthrough
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow";
import { Node } from "@smthrs/plan";
import * as Schema from "effect/Schema";
import { assessChangeImpact } from "../quiz/assessChangeImpact.ts";
import { shouldAutoQuiz } from "../quiz/shouldAutoQuiz.ts";
import { NarrateChanges, QuizChanges, ReviewFile, VerifyFindings } from "./reviewAgentActions.ts";
import {
  ApplyVerdicts,
  FinalizeReview,
  MAX_VERIFIABLE_FINDINGS,
  MergeFileBatch,
  PrepareReview,
  RenderWalkthrough,
} from "./reviewActions.ts";
import { NativeReviewAgentOutput } from "./openCodeReview.ts";
import { ReviewInput } from "./reviewInputSchema.ts";
import {
  FileOutcomes,
  NarrateReviewPayload,
  ReviewFilesPayload,
  ReviewResult,
  VerifyReviewPayload,
} from "./reviewSchemas.ts";

/**
 * What the per-file fan-out needs from the composition: the two action
 * implementations its batches dispatch.
 */
type FileReviewRequirement =
  | Action.Requirement<"smithers-review/ReviewFile">
  | Action.Requirement<"smithers-review/MergeFileBatch">;

/**
 * The narrating round: story, quiz, and the rendered walkthrough.
 *
 * Every model step here is caught, because a review whose narrator timed out is
 * still a review. `normalizeStory` falls back to the deterministic story and
 * `normalizeQuiz` answers `null`, which is exactly what a caught failure hands
 * the renderer.
 *
 * @since 1.0.0
 * @category flows
 */
export const NarrateReview = Flow.make("smithers-review/NarrateReview", {
  payload: NarrateReviewPayload,
  success: ReviewResult,
  body: ({ changes, input, review, target }) => {
    const impact = assessChangeImpact(changes.files, review.comments);
    const narrating = input.narrate && changes.files.length > 0;
    const quizzing = changes.files.length > 0 &&
      (input.quiz === "on" || (input.quiz === "auto" && shouldAutoQuiz(impact.level)));
    const story = narrating
      ? NarrateChanges.call({
        files: changes.files,
        comments: review.comments,
        background: input.background,
        mode: target.mode,
        ref: target.ref,
      }).pipe(Node.catch({ onFailure: () => Node.succeed(null) }))
      : Node.succeed(null);
    const quiz = quizzing
      ? QuizChanges.call({
        files: changes.files,
        findings: review.comments,
        impact: { level: impact.level, reasons: impact.reasons },
        background: input.background,
      }).pipe(Node.catch({ onFailure: () => Node.succeed(null) }))
      : Node.succeed(null);
    return Node.all({ story, quiz }).pipe(
      Node.bindPlanned((narrated) =>
        RenderWalkthrough.call({
          input,
          target,
          changes,
          review,
          story: narrated.story,
          quiz: narrated.quiz,
        })
      ),
      Node.map((rendered) => ({
        target,
        review,
        walkthrough: rendered.walkthrough,
        story: rendered.story,
        quiz: rendered.quiz,
      })),
    );
  },
});

/**
 * The verifying round.
 *
 * A verifier that fails is caught and reported as unverified rather than
 * failing the review: the findings are still the findings.
 *
 * @since 1.0.0
 * @category flows
 */
export const VerifyReview = Flow.make("smithers-review/VerifyReview", {
  payload: VerifyReviewPayload,
  success: ReviewResult,
  body: ({ changes, input, review, target }) => {
    const verifying = input.verify &&
      review.comments.length >= 1 &&
      review.comments.length <= MAX_VERIFIABLE_FINDINGS;
    if (!verifying) {
      return NarrateReview.to({ input, target, changes, review });
    }
    return VerifyFindings.call({ findings: review.comments, files: changes.files }).pipe(
      Node.catch({ onFailure: () => Node.succeed(null) }),
      Node.bindPlanned((verdicts) => ApplyVerdicts.call({ review, verdicts })),
      Node.bindPlanned((verified) => NarrateReview.to({ input, target, changes, review: verified })),
    );
  },
});

/**
 * The number of files one fan-out batch holds when the input names none.
 *
 * Batch width, not an enforced ceiling on the provider calls in flight; see
 * {@link ReviewFiles}.
 *
 * @since 1.0.0
 * @category constants
 */
export const DEFAULT_CONCURRENCY = 8;

/**
 * The file-review round.
 *
 * The fan-out is batched rather than one flat `Node.all` so each batch's
 * answers are folded into an accumulator by a recorded step: a resume
 * mid-review replays the batches that already settled instead of re-asking
 * their seats.
 *
 * `input.concurrency` is that batch width and nothing more. It does not bound
 * the provider calls in flight, and no shape this body can build would: the
 * interpreter settles every dependency of a node concurrently before running
 * the node (`packages/smithers/flows/flow/src/Interpreter.ts`, the `Effect.forEach` over
 * `KeyMaterial.dependencies` with `concurrency: "unbounded"` above the AST
 * switch), so a batch chained onto its predecessor with `Node.bindPlanned` starts
 * alongside it exactly as `Node.all` does. A five-file review makes five calls
 * at once whatever the flag says. `tests/workflow/reviewFlow.test.ts` holds
 * every scripted call open and pins that width. The ordering has to come from
 * the plan contract in `@smthrs/flow`, which this app does not own.
 *
 * @since 1.0.0
 * @category flows
 */
export const ReviewFiles = Flow.make("smithers-review/ReviewFiles", {
  payload: ReviewFilesPayload,
  success: ReviewResult,
  body: ({ input, prepared }) => {
    const files = prepared.prompt.shouldReview ? prepared.prompt.files : [];
    const width = Number.isSafeInteger(input.concurrency) && input.concurrency > 0
      ? input.concurrency
      : DEFAULT_CONCURRENCY;
    let outcomes: Node.Node<FileOutcomes, never, FileReviewRequirement> = Node.succeed<FileOutcomes>([]);
    for (let offset = 0; offset < files.length; offset += width) {
      const members: Record<string, Node.Node<NativeReviewAgentOutput | null, never, FileReviewRequirement>> = {};
      for (const file of files.slice(offset, offset + width)) {
        // A file whose review fails is a warning, not a dead run: 0.x spelled
        // this `continueOnFail`, and `finalizeNativeReview` turns the null into
        // a `subtask_error` warning against that file.
        members[file.id] = ReviewFile.call({ path: file.path, prompt: file.prompt }).pipe(
          Node.catch({ onFailure: () => Node.succeed(null) }),
        );
      }
      outcomes = Node.all({ previous: outcomes, batch: Node.all(members) }).pipe(
        Node.bindPlanned((both) => MergeFileBatch.call({ previous: both.previous, batch: both.batch })),
      );
    }
    return outcomes.pipe(
      Node.bindPlanned((collected) => FinalizeReview.call({ input, prepared, outcomes: collected })),
      Node.bindPlanned((review) =>
        VerifyReview.to({
          input,
          target: prepared.target,
          changes: prepared.changes,
          review,
        })
      ),
    );
  },
});

/**
 * The review workflow's entry point.
 *
 * @since 1.0.0
 * @category flows
 */
export const Review = Flow.make("smithers-review/Review", {
  payload: ReviewInput,
  success: ReviewResult,
  body: (input) =>
    PrepareReview.call({ input }).pipe(
      Node.bindPlanned((prepared) => ReviewFiles.to({ input, prepared })),
    ),
});

/**
 * Every flow the review workflow registers.
 *
 * @since 1.0.0
 * @category constants
 */
export const flows = [Review, ReviewFiles, VerifyReview, NarrateReview] as const;

/**
 * The result schema, re-exported so a host can decode a run's success without
 * importing the round schemas.
 *
 * @since 1.0.0
 * @category schemas
 */
export const Result: typeof ReviewResult = ReviewResult;

/**
 * A decoded review result.
 *
 * @since 1.0.0
 * @category models
 */
export type Result = Schema.Schema.Type<typeof ReviewResult>;
