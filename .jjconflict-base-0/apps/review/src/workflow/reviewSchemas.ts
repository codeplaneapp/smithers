/**
 * The schemas the review flow's rounds hand to one another.
 *
 * A round's payload is real data (`Flow.to` ends the round and starts the next
 * one with its payload decoded), which is what lets a body fan out over a file
 * list a previous round discovered. Everything a later round reads therefore
 * has to be declared here and carried, not recomputed: re-running `git diff` in
 * the last round would read a working tree that may have moved under the run.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
import { arrayOf, withDefault } from "../schema/withDefault.ts";
import { Quiz } from "../quiz/quizSchema.ts";
import { Changes } from "../walkthrough/changesSchema.ts";
import { Story } from "../walkthrough/storySchema.ts";
import {
  NativeReviewAgentOutput,
  NativeReviewPrompt,
  PreviewOutput,
  ReviewRunOutput,
  ReviewTarget,
} from "./openCodeReview.ts";
import { ReviewInput } from "./reviewInputSchema.ts";

/**
 * Everything the local git work produces in one durable step.
 *
 * @since 1.0.0
 * @category schemas
 */
export const PreparedReview = Schema.Struct({
  target: ReviewTarget,
  preview: PreviewOutput,
  changes: Changes,
  prompt: NativeReviewPrompt,
});

/**
 * A decoded preparation result.
 *
 * @since 1.0.0
 * @category models
 */
export type PreparedReview = typeof PreparedReview.Type;

/**
 * What one file's review seat produced, or `null` when its step failed.
 *
 * A failed file review is data, not a run failure: 0.x spelled that
 * `continueOnFail`, and `finalizeNativeReview` turns a null into a
 * `subtask_error` warning.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FileOutcome = Schema.Struct({
  fileId: Schema.String,
  output: Schema.NullOr(NativeReviewAgentOutput),
});

/**
 * A decoded per-file outcome.
 *
 * @since 1.0.0
 * @category models
 */
export type FileOutcome = typeof FileOutcome.Type;

/**
 * One concurrency batch's answers, keyed by the file's step id.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FileBatch = Schema.Record(Schema.String, Schema.NullOr(NativeReviewAgentOutput));

/**
 * A decoded batch.
 *
 * @since 1.0.0
 * @category models
 */
export type FileBatch = typeof FileBatch.Type;

/**
 * The payload the file-review round runs under.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReviewFilesPayload = Schema.Struct({
  input: ReviewInput,
  prepared: PreparedReview,
});

/**
 * The payload the verification round runs under.
 *
 * @since 1.0.0
 * @category schemas
 */
export const VerifyReviewPayload = Schema.Struct({
  input: ReviewInput,
  target: ReviewTarget,
  changes: Changes,
  review: ReviewRunOutput,
});

/**
 * The payload the narration round runs under. Its `review` is post-verification.
 *
 * @since 1.0.0
 * @category schemas
 */
export const NarrateReviewPayload = VerifyReviewPayload;

/**
 * The walkthrough file the last round writes, plus the derived material the
 * CLI composes a pull-request body from.
 *
 * `story` and `quiz` are JSON strings so a consumer can rehydrate them without
 * re-deriving them from the HTML.
 *
 * @since 1.0.0
 * @category schemas
 */
export const WalkthroughOutput = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Number,
  chapters: Schema.Number,
  files: Schema.Number,
  findings: Schema.Number,
  message: withDefault(Schema.String, ""),
  story: withDefault(Schema.String, ""),
  quiz: withDefault(Schema.String, ""),
  impact: withDefault(Schema.String, ""),
  questions: withDefault(Schema.Number, 0),
});

/**
 * A decoded walkthrough result.
 *
 * @since 1.0.0
 * @category models
 */
export type WalkthroughOutput = typeof WalkthroughOutput.Type;

/**
 * What a whole review run answers with.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReviewResult = Schema.Struct({
  target: ReviewTarget,
  review: ReviewRunOutput,
  walkthrough: WalkthroughOutput,
  story: Story,
  quiz: Schema.NullOr(Quiz),
});

/**
 * A decoded review result.
 *
 * @since 1.0.0
 * @category models
 */
export type ReviewResult = typeof ReviewResult.Type;

/**
 * The accumulator threaded through the concurrency batches.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FileOutcomes = withDefault(Schema.Array(FileOutcome), []);

/**
 * A decoded outcome list.
 *
 * @since 1.0.0
 * @category models
 */
export type FileOutcomes = typeof FileOutcomes.Type;
