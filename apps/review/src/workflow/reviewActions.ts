/**
 * The review flow's non-model steps.
 *
 * Every one of these is local git work or pure computation, declared with
 * `Action.make` so the run records it once and a resume replays the record
 * instead of re-shelling out. The implementations are the 0.x functions
 * unchanged; only the declaration around them is new.
 *
 * @since 1.0.0
 */
import { Action } from "@smthrs/flow";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assessChangeImpact } from "../quiz/assessChangeImpact.ts";
import { normalizeQuiz } from "../quiz/normalizeQuiz.ts";
import { Quiz } from "../quiz/quizSchema.ts";
import { pluralize } from "../text/pluralize.ts";
import { Changes } from "../walkthrough/changesSchema.ts";
import { collectChanges } from "../walkthrough/collectChanges.ts";
import { normalizeStory } from "../walkthrough/normalizeStory.ts";
import { renderWalkthroughHtml } from "../walkthrough/renderWalkthroughHtml.ts";
import { Story } from "../walkthrough/storySchema.ts";
import { applyFindingVerdicts } from "./applyFindingVerdicts.ts";
import {
  buildNativeReviewPrompt,
  finalizeNativeReview,
  previewOpenCodeReview,
  ReviewRunOutput,
  ReviewTarget,
  resolveReviewTarget,
} from "./openCodeReview.ts";
import { ReviewInput } from "./reviewInputSchema.ts";
import {
  FileBatch,
  FileOutcome,
  FileOutcomes,
  PreparedReview,
  WalkthroughOutput,
} from "./reviewSchemas.ts";
import { VerifyVerdicts } from "./verifyVerdictsSchema.ts";

/**
 * Verification is only worth an agent round trip for a plausible finding count.
 * A review with hundreds of comments is noise the verifier cannot honestly
 * adjudicate in one pass.
 *
 * @since 1.0.0
 * @category constants
 */
export const MAX_VERIFIABLE_FINDINGS = 40;

/**
 * Resolves the target, previews the change set, collects every diff, and builds
 * the per-file review prompts.
 *
 * One step rather than four because all four read the same working tree at the
 * same instant. Splitting them would let the tree move between them and leave
 * a review whose prompts and walkthrough disagree about what changed.
 *
 * @since 1.0.0
 * @category actions
 */
export const PrepareReview = Action.make("smithers-review/PrepareReview", {
  payload: { input: ReviewInput },
  success: PreparedReview,
});

/**
 * The implementation layer for {@link PrepareReview}.
 *
 * @since 1.0.0
 * @category layers
 */
export const prepareReviewLayer = PrepareReview.toLayer(({ input }) =>
  Effect.promise(async () => {
    // Without review seats the per-file steps never run, so the finalizer must
    // see `runReview: false` and report "skipped" rather than "failed".
    const target = await resolveReviewTarget(input);
    const preview = await previewOpenCodeReview(input);
    const changes = await collectChanges(input, preview);
    const prompt = await buildNativeReviewPrompt(input, preview);
    return { target, preview, changes, prompt };
  })
);

/**
 * Appends one concurrency batch's answers to the outcomes collected so far.
 *
 * The batch arrives keyed by step id because `Node.all` is keyed, and the file
 * order the finalizer needs is recovered from the prepared prompt rather than
 * from completion order.
 *
 * @since 1.0.0
 * @category actions
 */
export const MergeFileBatch = Action.make("smithers-review/MergeFileBatch", {
  payload: { previous: FileOutcomes, batch: FileBatch },
  success: FileOutcomes,
});

/**
 * The implementation layer for {@link MergeFileBatch}.
 *
 * @since 1.0.0
 * @category layers
 */
export const mergeFileBatchLayer = MergeFileBatch.toLayer(({ batch, previous }) =>
  Effect.sync(() => {
    const merged: Array<FileOutcome> = [...previous];
    for (const fileId of Object.keys(batch).sort()) {
      merged.push({ fileId, output: batch[fileId] ?? null });
    }
    return merged;
  })
);

/**
 * Turns the per-file answers into one review: scope, anchor, de-duplicate,
 * sort, and count.
 *
 * @since 1.0.0
 * @category actions
 */
export const FinalizeReview = Action.make("smithers-review/FinalizeReview", {
  payload: { input: ReviewInput, prepared: PreparedReview, outcomes: FileOutcomes },
  success: ReviewRunOutput,
});

/**
 * The implementation layer for {@link FinalizeReview}.
 *
 * @since 1.0.0
 * @category layers
 */
export const finalizeReviewLayer = FinalizeReview.toLayer(({ input, outcomes, prepared }) =>
  Effect.sync(() => {
    const byFileId = new Map(outcomes.map((outcome) => [outcome.fileId, outcome.output]));
    const results = prepared.prompt.files.map((file) => ({
      file,
      output: byFileId.get(file.id) ?? null,
    }));
    const finalized = finalizeNativeReview(input, prepared.prompt, prepared.preview, results);
    const verifyRequested = input.verify;
    if (verifyRequested && finalized.comments.length > MAX_VERIFIABLE_FINDINGS) {
      // Silently skipping verification would read as "verified"; surface the
      // cap so downstream consumers show it.
      return {
        ...finalized,
        warnings: [
          ...finalized.warnings,
          {
            file: "",
            type: "verifier_skipped",
            message:
              `${finalized.comments.length} findings exceeds the ${MAX_VERIFIABLE_FINDINGS}-finding verification cap; findings are unverified.`,
          },
        ],
      };
    }
    return finalized;
  })
);

/**
 * Applies the verifier's verdicts to the review.
 *
 * A `null` verdict set means the verifier step failed and was caught: the
 * review is kept as it stands and a `verifier_error` warning records that
 * nothing was verified.
 *
 * @since 1.0.0
 * @category actions
 */
export const ApplyVerdicts = Action.make("smithers-review/ApplyVerdicts", {
  payload: { review: ReviewRunOutput, verdicts: Schema.NullOr(VerifyVerdicts) },
  success: ReviewRunOutput,
});

/**
 * The implementation layer for {@link ApplyVerdicts}.
 *
 * @since 1.0.0
 * @category layers
 */
export const applyVerdictsLayer = ApplyVerdicts.toLayer(({ review, verdicts }) =>
  Effect.sync(() => {
    if (verdicts === null) {
      return {
        ...review,
        warnings: [
          ...review.warnings,
          {
            file: "",
            type: "verifier_error",
            message: "Finding verification produced no output; findings are unverified.",
          },
        ],
      };
    }
    const applied = applyFindingVerdicts(review.comments, verdicts.verdicts);
    return {
      ...review,
      comments: applied.findings,
      warnings: [...review.warnings, ...applied.warnings],
      summary: review.summary ? { ...review.summary, comments: applied.findings.length } : null,
      message: applied.dropped > 0
        ? `${review.message} Verification dropped ${pluralize(applied.dropped, "finding")}.`
        : review.message,
    };
  })
);

/**
 * Renders the story-form HTML walkthrough and writes it to disk.
 *
 * @since 1.0.0
 * @category actions
 */
export const RenderWalkthrough = Action.make("smithers-review/RenderWalkthrough", {
  payload: {
    input: ReviewInput,
    target: ReviewTarget,
    changes: Changes,
    review: ReviewRunOutput,
    story: Schema.NullOr(Story),
    quiz: Schema.NullOr(Quiz),
  },
  success: Schema.Struct({
    walkthrough: WalkthroughOutput,
    story: Story,
    quiz: Schema.NullOr(Quiz),
  }),
});

/**
 * The implementation layer for {@link RenderWalkthrough}.
 *
 * @since 1.0.0
 * @category layers
 */
export const renderWalkthroughLayer = RenderWalkthrough.toLayer(
  ({ changes, input, quiz: rawQuiz, review, story: rawStory, target }) =>
    Effect.promise(async () => {
      const story = normalizeStory(rawStory, changes.files);
      const impact = assessChangeImpact(changes.files, review.comments);
      const quiz = rawQuiz
        ? normalizeQuiz(rawQuiz, changes.files.map((file) => file.path))
        : null;
      const html = await renderWalkthroughHtml({
        title: input.title,
        story,
        files: changes.files,
        comments: review.comments,
        repoDir: target.repoDir,
        mode: target.mode,
        ref: target.ref,
        generatedAt: new Date().toISOString(),
        diffStyle: (input.split ? "split" : "unified") as "split" | "unified",
        quiz,
        impact: { level: impact.level, reasons: impact.reasons },
      });
      const requested = input.out.trim();
      const outPath = requested
        ? isAbsolute(requested) ? requested : resolve(target.repoDir, requested)
        : join(target.repoDir, ".smithers-review", "walkthrough.html");
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, html);
      return {
        walkthrough: {
          path: outPath,
          bytes: Buffer.byteLength(html),
          chapters: story.chapters.length,
          files: changes.files.length,
          findings: review.comments.length,
          message: `Walkthrough written to ${outPath} (${pluralize(story.chapters.length, "chapter")}, ${
            pluralize(review.comments.length, "finding")
          }).`,
          story: JSON.stringify(story),
          quiz: quiz ? JSON.stringify(quiz) : "",
          impact: impact.level,
          questions: quiz ? quiz.questions.length : 0,
        },
        story,
        quiz,
      };
    })
);
