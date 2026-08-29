/** @jsxImportSource smthrs */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createSmithers, Parallel, Sequence, type AgentLike } from "smthrs";
import {
  buildNativeReviewPrompt,
  finalizeNativeReview,
  nativeReviewAgentOutputSchema,
  nativeReviewPromptSchema,
  previewOpenCodeReview,
  previewOutputSchema,
  resolveReviewTarget,
  reviewRunOutputSchema,
  reviewTargetSchema,
} from "./openCodeReview";
import { z } from "zod/v4";
import { pluralize } from "../text/pluralize";
import { assessChangeImpact } from "../quiz/assessChangeImpact";
import { buildQuizPrompt } from "../quiz/buildQuizPrompt";
import { normalizeQuiz } from "../quiz/normalizeQuiz";
import { quizSchema } from "../quiz/quizSchema";
import { shouldAutoQuiz } from "../quiz/shouldAutoQuiz";
import { buildNarratePrompt } from "../walkthrough/buildNarratePrompt";
import { changesSchema } from "../walkthrough/changesSchema";
import { collectChanges } from "../walkthrough/collectChanges";
import { normalizeStory } from "../walkthrough/normalizeStory";
import { renderWalkthroughHtml } from "../walkthrough/renderWalkthroughHtml";
import { storySchema } from "../walkthrough/storySchema";
import { applyFindingVerdicts } from "./applyFindingVerdicts";
import { normalizeReviewInput } from "./normalizeReviewInput";
import { reviewInputSchema } from "./reviewInputSchema";
import { buildVerifyFindingsPrompt } from "./verifyFindings";
import { verifyVerdictsSchema } from "./verifyVerdictsSchema";

// Verification is only worth an agent round-trip for a plausible finding
// count; a review with hundreds of comments is noise the verifier cannot
// honestly adjudicate in one pass.
const MAX_VERIFIABLE_FINDINGS = 40;

// Single-word column names on purpose: loadOutputs returns columns camelCased,
// so single words round-trip unchanged. story/quiz hold JSON strings by design
// (they are z.string(), not json-mode array columns that loadOutputs parses).
const walkthroughOutputSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  chapters: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
  message: z.string().default(""),
  // JSON of the normalized story, so the CLI can compose PR review bodies
  // without re-deriving it.
  story: z.string().default(""),
  // JSON of the normalized quiz ("" when the quiz did not run or produced
  // nothing valid), the assessed impact level, and the question count.
  quiz: z.string().default(""),
  impact: z.string().default(""),
  questions: z.number().int().nonnegative().default(0),
});

export function createReviewWorkflow(opts: {
  dbPath: string;
  reviewAgents?: AgentLike[];
  narratorAgents?: AgentLike[];
  verifyAgents?: AgentLike[];
  quizAgents?: AgentLike[];
}) {
  mkdirSync(dirname(resolve(opts.dbPath)), { recursive: true });
  const api = createSmithers(
    {
      input: reviewInputSchema,
      target: reviewTargetSchema,
      preview: previewOutputSchema,
      reviewPrompt: nativeReviewPromptSchema,
      agentReview: nativeReviewAgentOutputSchema,
      review: reviewRunOutputSchema,
      verdicts: verifyVerdictsSchema,
      final: reviewRunOutputSchema,
      quiz: quizSchema,
      changes: changesSchema,
      story: storySchema,
      walkthrough: walkthroughOutputSchema,
    },
    { dbPath: opts.dbPath },
  );
  const { Workflow, Task, smithers, outputs } = api;
  const reviewAgents = opts.reviewAgents ?? [];
  const narratorAgents = opts.narratorAgents ?? [];
  const verifyAgents = opts.verifyAgents ?? reviewAgents;
  const quizAgents = opts.quizAgents ?? (narratorAgents.length > 0 ? narratorAgents : reviewAgents);

  const workflow = smithers((ctx) => {
    const input = normalizeReviewInput(ctx.input);
    // Without review agents the per-file tasks never run, so the finalizer
    // must see runReview=false and report "skipped" instead of "failed".
    const reviewInput = { ...input, runReview: input.runReview && reviewAgents.length > 0 };
    const prepared = ctx.outputMaybe(outputs.reviewPrompt, { nodeId: "prepare-review" });
    const changes = ctx.outputMaybe(outputs.changes, { nodeId: "collect-changes" });
    const review = ctx.outputMaybe(outputs.review, { nodeId: "review" });
    const reviewFiles = prepared?.shouldReview ? prepared.files : [];
    const reviewFileIds = reviewFiles.map((file) => file.id);
    const verifying =
      input.verify &&
      verifyAgents.length > 0 &&
      reviewAgents.length > 0 &&
      review != null &&
      review.comments.length >= 1 &&
      review.comments.length <= MAX_VERIFIABLE_FINDINGS;
    // The review every downstream consumer (narrate, quiz, walkthrough, PR
    // posting via the `final` table) sees: post-verification when the verify
    // pass runs, the raw review otherwise.
    const finalReview = verifying ? ctx.outputMaybe(outputs.final, { nodeId: "final-review" }) : review;
    const narrating =
      input.narrate && narratorAgents.length > 0 && (changes?.files.length ?? 0) > 0 && finalReview != null;
    // Impact is assessed from the changes alone when the review pass is off
    // or failed, so the quiz can still run (with empty findings).
    const impact = changes != null ? assessChangeImpact(changes.files, finalReview?.comments ?? []) : null;
    const quizzing =
      quizAgents.length > 0 &&
      changes != null &&
      changes.files.length > 0 &&
      impact != null &&
      (input.quiz === "on" || (input.quiz === "auto" && shouldAutoQuiz(impact.level)));
    const agentTimeoutMs = input.timeout * 60_000;
    const heartbeatTimeoutMs = Math.max(60_000, Math.min(agentTimeoutMs, 600_000));

    return (
      <Workflow name="smithers-review">
        <Sequence>
          <Task id="resolve-target" output={outputs.target} noRetry>
            {async () => resolveReviewTarget(reviewInput)}
          </Task>

          <Task id="preview" output={outputs.preview} noRetry>
            {async () => previewOpenCodeReview(reviewInput)}
          </Task>

          <Task id="collect-changes" output={outputs.changes} dependsOn={["preview"]} noRetry>
            {async () => {
              const preview = ctx.outputMaybe(outputs.preview, { nodeId: "preview" });
              if (!preview) throw new Error("preview did not complete");
              return collectChanges(reviewInput, preview);
            }}
          </Task>

          <Task id="prepare-review" output={outputs.reviewPrompt} dependsOn={["preview"]} noRetry>
            {async () => {
              const preview = ctx.outputMaybe(outputs.preview, { nodeId: "preview" });
              if (!preview) throw new Error("preview did not complete");
              return buildNativeReviewPrompt(reviewInput, preview);
            }}
          </Task>

          {reviewFiles.length > 0 ? (
            <Parallel maxConcurrency={input.concurrency}>
              {reviewFiles.map((file) => (
                <Task
                  key={file.id}
                  id={file.id}
                  output={outputs.agentReview}
                  agent={reviewAgents}
                  dependsOn={["prepare-review"]}
                  timeoutMs={agentTimeoutMs}
                  heartbeatTimeoutMs={heartbeatTimeoutMs}
                  continueOnFail
                  noRetry
                >
                  {file.prompt}
                </Task>
              ))}
            </Parallel>
          ) : null}

          <Task id="review" output={outputs.review} dependsOn={["prepare-review", ...reviewFileIds]} noRetry>
            {() => {
              const preview = ctx.outputMaybe(outputs.preview, { nodeId: "preview" });
              const reviewPrompt = ctx.outputMaybe(outputs.reviewPrompt, { nodeId: "prepare-review" });
              if (!preview) throw new Error("preview did not complete");
              if (!reviewPrompt) throw new Error("review prompt did not complete");
              const fileResults = reviewPrompt.files.map((file) => ({
                file,
                output: ctx.outputMaybe(outputs.agentReview, { nodeId: file.id }),
              }));
              const finalized = finalizeNativeReview(reviewInput, reviewPrompt, preview, fileResults);
              const verifyRequested = input.verify && verifyAgents.length > 0 && reviewAgents.length > 0;
              if (verifyRequested && finalized.comments.length > MAX_VERIFIABLE_FINDINGS) {
                // Silently skipping verification would read as "verified";
                // surface the cap so downstream consumers show it.
                return {
                  ...finalized,
                  warnings: [
                    ...finalized.warnings,
                    {
                      file: "",
                      type: "verifier_skipped",
                      message: `${finalized.comments.length} findings exceeds the ${MAX_VERIFIABLE_FINDINGS}-finding verification cap; findings are unverified.`,
                    },
                  ],
                };
              }
              return finalized;
            }}
          </Task>

          {verifying ? (
            <Task
              id="verify-findings"
              output={outputs.verdicts}
              agent={verifyAgents}
              dependsOn={["collect-changes", "review"]}
              timeoutMs={agentTimeoutMs}
              heartbeatTimeoutMs={heartbeatTimeoutMs}
              continueOnFail
              noRetry
            >
              {buildVerifyFindingsPrompt({
                findings: review.comments.map((comment) => ({
                  path: comment.path,
                  content: comment.content,
                  severity: comment.severity,
                  category: comment.category,
                  confidence: comment.confidence,
                  startLine: comment.startLine,
                  endLine: comment.endLine,
                  existingCode: comment.existingCode,
                })),
                filesByPath: new Map((changes?.files ?? []).map((file) => [file.path, { diff: file.diff }])),
              })}
            </Task>
          ) : null}

          {verifying ? (
            <Task id="final-review" output={outputs.final} dependsOn={["verify-findings"]} noRetry>
              {() => {
                const reviewOut = ctx.outputMaybe(outputs.review, { nodeId: "review" });
                if (!reviewOut) throw new Error("review did not complete");
                const verdictsOut = ctx.outputMaybe(outputs.verdicts, { nodeId: "verify-findings" });
                if (!verdictsOut) {
                  // Verifier failed (continueOnFail): keep the review as-is but
                  // record that verification did not happen.
                  return {
                    ...reviewOut,
                    warnings: [
                      ...reviewOut.warnings,
                      {
                        file: "",
                        type: "verifier_error",
                        message: "Finding verification produced no output; findings are unverified.",
                      },
                    ],
                  };
                }
                const applied = applyFindingVerdicts(reviewOut.comments, verdictsOut.verdicts);
                return {
                  ...reviewOut,
                  comments: applied.findings,
                  warnings: [...reviewOut.warnings, ...applied.warnings],
                  summary: reviewOut.summary ? { ...reviewOut.summary, comments: applied.findings.length } : null,
                  message:
                    applied.dropped > 0
                      ? `${reviewOut.message} Verification dropped ${pluralize(applied.dropped, "finding")}.`
                      : reviewOut.message,
                };
              }}
            </Task>
          ) : null}

          {narrating ? (
            <Task
              id="narrate"
              output={outputs.story}
              agent={narratorAgents}
              dependsOn={["collect-changes", "review", ...(verifying ? ["final-review"] : [])]}
              timeoutMs={agentTimeoutMs}
              heartbeatTimeoutMs={heartbeatTimeoutMs}
              continueOnFail
              noRetry
            >
              {buildNarratePrompt({
                files: changes?.files ?? [],
                comments: finalReview?.comments ?? [],
                background: input.background,
                mode: reviewInput.commit.trim() ? "commit" : reviewInput.from.trim() ? "range" : "workspace",
                ref:
                  reviewInput.commit.trim() ||
                  (reviewInput.from.trim() ? `${reviewInput.from}..${reviewInput.to}` : "workspace"),
              })}
            </Task>
          ) : null}

          {quizzing ? (
            <Task
              id="quiz"
              output={outputs.quiz}
              agent={quizAgents}
              dependsOn={["collect-changes", "review", ...(verifying ? ["final-review"] : [])]}
              timeoutMs={agentTimeoutMs}
              heartbeatTimeoutMs={heartbeatTimeoutMs}
              continueOnFail
              noRetry
            >
              {buildQuizPrompt({
                files: changes?.files ?? [],
                findings: finalReview?.comments ?? [],
                impact: { level: impact.level, reasons: impact.reasons },
                background: input.background,
              })}
            </Task>
          ) : null}

          <Task
            id="walkthrough"
            output={outputs.walkthrough}
            dependsOn={[
              "resolve-target",
              "collect-changes",
              "review",
              ...(verifying ? ["final-review"] : []),
              ...(narrating ? ["narrate"] : []),
              ...(quizzing ? ["quiz"] : []),
            ]}
            noRetry
          >
            {async () => {
              const target = ctx.outputMaybe(outputs.target, { nodeId: "resolve-target" });
              const changesOut = ctx.outputMaybe(outputs.changes, { nodeId: "collect-changes" });
              const reviewOut = verifying
                ? ctx.outputMaybe(outputs.final, { nodeId: "final-review" })
                : ctx.outputMaybe(outputs.review, { nodeId: "review" });
              const storyOut = ctx.outputMaybe(outputs.story, { nodeId: "narrate" });
              const quizOut = quizzing ? ctx.outputMaybe(outputs.quiz, { nodeId: "quiz" }) : null;
              if (!target) throw new Error("target did not complete");
              if (!changesOut) throw new Error("collect-changes did not complete");
              if (!reviewOut) throw new Error("review did not complete");
              const story = normalizeStory(storyOut, changesOut.files);
              const changeImpact = assessChangeImpact(changesOut.files, reviewOut.comments);
              const quiz = quizOut
                ? normalizeQuiz(
                    quizOut,
                    changesOut.files.map((file) => file.path),
                  )
                : null;
              // Built as a variable (not an inline literal) so the quiz/impact
              // fields pass typecheck before renderWalkthroughHtml declares
              // them; structural typing ignores extra props on non-literals.
              const renderArgs = {
                title: input.title,
                story,
                files: changesOut.files,
                comments: reviewOut.comments,
                repoDir: target.repoDir,
                mode: target.mode,
                ref: target.ref,
                generatedAt: new Date().toISOString(),
                diffStyle: (input.split ? "split" : "unified") as "split" | "unified",
                quiz,
                impact: { level: changeImpact.level, reasons: changeImpact.reasons },
              };
              const html = await renderWalkthroughHtml(renderArgs);
              const requested = input.out.trim();
              const outPath = requested
                ? isAbsolute(requested)
                  ? requested
                  : resolve(target.repoDir, requested)
                : join(target.repoDir, ".smithers-review", "walkthrough.html");
              mkdirSync(dirname(outPath), { recursive: true });
              writeFileSync(outPath, html);
              return {
                path: outPath,
                bytes: Buffer.byteLength(html),
                chapters: story.chapters.length,
                files: changesOut.files.length,
                findings: reviewOut.comments.length,
                message: `Walkthrough written to ${outPath} (${pluralize(story.chapters.length, "chapter")}, ${pluralize(reviewOut.comments.length, "finding")}).`,
                story: JSON.stringify(story),
                quiz: quiz ? JSON.stringify(quiz) : "",
                impact: changeImpact.level,
                questions: quiz ? quiz.questions.length : 0,
              };
            }}
          </Task>
        </Sequence>
      </Workflow>
    );
  });

  return { workflow, db: api.db, tables: api.tables, outputs };
}
