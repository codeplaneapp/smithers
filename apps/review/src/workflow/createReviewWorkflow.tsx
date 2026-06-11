/** @jsxImportSource smithers-orchestrator */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createSmithers, Parallel, Sequence, type AgentLike } from "smithers-orchestrator";
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
} from "smithers-workflows/lib/open-code-review";
import { z } from "zod/v4";
import { buildNarratePrompt } from "../walkthrough/buildNarratePrompt";
import { changesSchema } from "../walkthrough/changesSchema";
import { collectChanges } from "../walkthrough/collectChanges";
import { normalizeStory } from "../walkthrough/normalizeStory";
import { renderWalkthroughHtml } from "../walkthrough/renderWalkthroughHtml";
import { storySchema } from "../walkthrough/storySchema";
import { normalizeReviewInput } from "./normalizeReviewInput";
import { reviewInputSchema } from "./reviewInputSchema";

// Single-word column names on purpose: output rows come back snake_cased from
// loadOutputs, single words round-trip unchanged (see the spec).
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
});

export function createReviewWorkflow(opts: {
  dbPath: string;
  reviewAgents?: AgentLike[];
  narratorAgents?: AgentLike[];
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
      changes: changesSchema,
      story: storySchema,
      walkthrough: walkthroughOutputSchema,
    },
    { dbPath: opts.dbPath },
  );
  const { Workflow, Task, smithers, outputs } = api;
  const reviewAgents = opts.reviewAgents ?? [];
  const narratorAgents = opts.narratorAgents ?? [];

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
    const narrating =
      input.narrate && narratorAgents.length > 0 && (changes?.files.length ?? 0) > 0 && review != null;
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
              return finalizeNativeReview(reviewInput, reviewPrompt, preview, fileResults);
            }}
          </Task>

          {narrating ? (
            <Task
              id="narrate"
              output={outputs.story}
              agent={narratorAgents}
              dependsOn={["collect-changes", "review"]}
              timeoutMs={agentTimeoutMs}
              heartbeatTimeoutMs={heartbeatTimeoutMs}
              continueOnFail
              noRetry
            >
              {buildNarratePrompt({
                files: changes?.files ?? [],
                comments: review?.comments ?? [],
                background: input.background,
                mode: reviewInput.commit.trim() ? "commit" : reviewInput.from.trim() ? "range" : "workspace",
                ref: reviewInput.commit.trim() || (reviewInput.from.trim() ? `${reviewInput.from}..${reviewInput.to}` : "workspace"),
              })}
            </Task>
          ) : null}

          <Task
            id="walkthrough"
            output={outputs.walkthrough}
            dependsOn={["resolve-target", "collect-changes", "review", ...(narrating ? ["narrate"] : [])]}
            noRetry
          >
            {async () => {
              const target = ctx.outputMaybe(outputs.target, { nodeId: "resolve-target" });
              const changesOut = ctx.outputMaybe(outputs.changes, { nodeId: "collect-changes" });
              const reviewOut = ctx.outputMaybe(outputs.review, { nodeId: "review" });
              const storyOut = ctx.outputMaybe(outputs.story, { nodeId: "narrate" });
              if (!target) throw new Error("target did not complete");
              if (!changesOut) throw new Error("collect-changes did not complete");
              if (!reviewOut) throw new Error("review did not complete");
              const story = normalizeStory(storyOut, changesOut.files);
              const html = await renderWalkthroughHtml({
                title: input.title,
                story,
                files: changesOut.files,
                comments: reviewOut.comments,
                repoDir: target.repoDir,
                mode: target.mode,
                ref: target.ref,
                generatedAt: new Date().toISOString(),
                diffStyle: input.split ? "split" : "unified",
              });
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
                message: `Walkthrough written to ${outPath} (${story.chapters.length} chapter(s), ${reviewOut.comments.length} finding(s)).`,
                story: JSON.stringify(story),
              };
            }}
          </Task>
        </Sequence>
      </Workflow>
    );
  });

  return { workflow, db: api.db, tables: api.tables, outputs };
}
