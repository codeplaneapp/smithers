// smithers-display-name: Release Content
// smithers-description: Generate claim-checked changelogs, launch threads, and release blog posts with dry-run previews, approval markers, and optional publishing.
// smithers-tags: marketing, release, changelog, publish
/** @jsxImportSource smithers-orchestrator */
import { Database } from "bun:sqlite";
import { createSmithers, approvalDecisionSchema } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

// Luna writes and researches release content; Sol scores it; Terra handles the
// routine commit step. Generated agent pools retain non-Codex fallback only.
const contentAgent = agents.implement;
import AnalyzeReleasePrompt from "../prompts/release-content/analyze-release.mdx";
import DraftBlogPrompt from "../prompts/release-content/draft-blog.mdx";
import DraftBlogOutlinePrompt from "../prompts/release-content/draft-blog-outline.mdx";
import DraftChangelogPrompt from "../prompts/release-content/draft-changelog.mdx";
import DraftThreadPrompt from "../prompts/release-content/draft-thread.mdx";
import EditContentPrompt from "../prompts/release-content/edit-content.mdx";
import ScoreContentPrompt from "../prompts/release-content/score-content.mdx";
import { collectReleaseContext, probeRelease } from "../lib/release-content/git";
import {
  enforceQualityGate,
  runDeterministicChecks,
} from "../lib/release-content/quality";
import {
  publishFiles,
  recordApprovalArtifact,
  writePreviewArtifacts,
} from "../lib/release-content/files";
import { renderMediaAssets } from "../lib/release-content/media";
import { chooseTemplate } from "../lib/release-content/templates";
import { postThread } from "../lib/release-content/x";
import {
  artifactWriteSchema,
  approvalRecordSchema,
  blogDraftSchema,
  blogOutlineSchema,
  changelogDraftSchema,
  collectedContextSchema,
  contentBriefSchema,
  deterministicCheckSchema,
  editedContentSchema,
  mediaAssetsSchema,
  normalizeReleaseContentInput,
  probeSchema,
  publishResultSchema,
  releaseAnalysisSchema,
  releaseContentInputSchema,
  scoreReportSchema,
  templateSelectionSchema,
  threadDraftSchema,
  type CollectedContext,
  type ContentBrief,
  type Probe,
  type ReleaseAnalysis,
  type ReleaseContentInput,
  type TemplateSelection,
} from "../lib/release-content/schemas";

const qualityGateSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});

const commitResultSchema = z.object({
  committed: z.boolean(),
  commit: z.string().nullable().default(null),
  message: z.string(),
});

const { Workflow, Task, Sequence, Parallel, Branch, Loop, Approval, smithers, outputs } =
  createSmithers({
    input: releaseContentInputSchema,
    probe: probeSchema,
    collectedContext: collectedContextSchema,
    releaseAnalysis: releaseAnalysisSchema,
    templateSelection: templateSelectionSchema,
    contentBrief: contentBriefSchema,
    changelogDraft: changelogDraftSchema,
    threadDraft: threadDraftSchema,
    blogOutline: blogOutlineSchema,
    blogDraft: blogDraftSchema,
    editedContent: editedContentSchema,
    deterministicCheck: deterministicCheckSchema,
    scoreReport: scoreReportSchema,
    media: mediaAssetsSchema,
    artifacts: artifactWriteSchema,
    qualityGate: qualityGateSchema,
    approval: approvalDecisionSchema,
    approvalRecord: approvalRecordSchema,
    publishResult: publishResultSchema,
    commitResult: commitResultSchema,
  });

function manualAnalysis(input: ReleaseContentInput, probe: Probe, context: CollectedContext): ReleaseAnalysis {
  const highlights = input.releaseContext.manualHighlights;
  const summary =
    input.releaseContext.summary ??
    highlights[0] ??
    `Smithers ${probe.version} release content generated from manual context.`;
  const claimLedger = highlights.map((claim, index) => ({
    id: `claim-manual-${index + 1}`,
    claim,
    sources: [
      {
        kind: "manual" as const,
        ref: `releaseContext.manualHighlights[${index}]`,
        quoteOrSummary: claim,
        confidence: 0.85,
      },
    ],
    allowedInMarketing: true,
    risk: "low" as const,
  }));
  return {
    version: probe.version,
    title: input.releaseContext.title ?? `Smithers ${probe.version}`,
    oneSentenceSummary: summary,
    primaryAudience: input.template.audience,
    releaseType: highlights.length >= 4 ? "launch-roundup" : "agent-workflow-primitive",
    userVisibleChanges: highlights,
    internalChanges: context.changedFiles.slice(0, 12),
    breakingChanges: input.releaseContext.manualRisks,
    migrationNotes: [],
    proofAssets: input.releaseContext.manualProof.map((proof, index) => ({
      kind: "manual" as const,
      ref: `releaseContext.manualProof[${index}]`,
      quoteOrSummary: proof,
      confidence: 0.85,
    })),
    claimLedger,
  };
}

function buildContentBrief(
  input: ReleaseContentInput,
  probe: Probe,
  analysis: ReleaseAnalysis,
  selected: TemplateSelection,
): ContentBrief {
  const topClaims = analysis.claimLedger
    .filter((claim) => claim.allowedInMarketing)
    .slice(0, 6)
    .map((claim) => claim.id);
  return {
    headline: input.releaseContext.title ?? analysis.title ?? `Smithers ${probe.version}`,
    subheadline: analysis.oneSentenceSummary,
    oneSentencePositioning:
      "Smithers is the durable runtime layer for long-running coding agents: persisted state, retries, approvals, replay, sandboxes, evals, and observability.",
    primaryAudience: analysis.primaryAudience,
    oldWay: "Start an agent and hope the process, sandbox, approvals, and output all land cleanly.",
    newWay:
      "Run agent work through a durable, inspectable Smithers workflow with explicit runtime semantics.",
    topClaims,
    proof: analysis.proofAssets.map((asset) => `${asset.ref}: ${asset.quoteOrSummary}`),
    forbiddenClaims: selected.forbiddenClaims,
    cta: input.tweetThread.ctaUrl,
    templateId: selected.templateId,
    channelAngles: selected.channelPlan,
  };
}

export default smithers((rawCtx) => {
  const input = normalizeReleaseContentInput(rawCtx.input);
  if (input.version === undefined && input.bump === undefined) {
    try {
      const db = new Database("smithers.db", { readonly: true });
      const row = db
        .query("select version, bump from input where run_id = ?")
        .get(rawCtx.runId) as { version?: string | null; bump?: "patch" | "minor" | "major" | null } | null;
      db.close();
      if (row?.version || row?.bump) {
        Object.assign(input, {
          version: row.version ?? input.version,
          bump: row.bump ?? input.bump,
        });
      }
    } catch {
      // Best effort: older stores or non-SQLite backends can still use the decoded input.
    }
  }
  const probe = rawCtx.outputMaybe(outputs.probe, { nodeId: "probe-release" });
  const context = rawCtx.outputMaybe(outputs.collectedContext, { nodeId: "collect-context" });
  const analysis = rawCtx.outputMaybe(outputs.releaseAnalysis, { nodeId: "analyze-release" });
  const selected = rawCtx.outputMaybe(outputs.templateSelection, { nodeId: "select-template" });
  const brief = rawCtx.outputMaybe(outputs.contentBrief, { nodeId: "draft-content-brief" });
  const changelog = rawCtx.outputMaybe(outputs.changelogDraft, { nodeId: "draft-changelog" });
  const thread = rawCtx.outputMaybe(outputs.threadDraft, { nodeId: "draft-thread" });
  const blog = rawCtx.outputMaybe(outputs.blogDraft, { nodeId: "draft-blog" });
  const latestEdited = rawCtx.outputs.editedContent?.at(-1);
  const latestCheck = rawCtx.outputs.deterministicCheck?.at(-1);
  const latestScore = rawCtx.outputs.scoreReport?.at(-1);
  const media = rawCtx.outputMaybe(outputs.media, { nodeId: "render-media" });
  const artifacts = rawCtx.outputMaybe(outputs.artifacts, { nodeId: "write-preview-artifacts" });
  const approval = rawCtx.outputMaybe(outputs.approval, { nodeId: "approve-content" });
  const publishResult = rawCtx.outputs.publishResult?.at(-1);
  const changelogReady = !input.channels.changelog || input.skip.changelog || changelog !== undefined;
  const threadReady = !input.channels.tweetThread || input.skip.tweetThread || thread !== undefined;
  const blogReady = !input.channels.blogPost || input.skip.blogPost || blog !== undefined;
  const draftsReady = changelogReady && threadReady && blogReady;

  const scorePassed =
    input.skip.scoring ||
    (latestScore !== undefined && latestScore.passed && latestScore.score >= input.quality.minScore);
  const qualityLoopDone = latestEdited !== undefined && latestCheck !== undefined && scorePassed;
  const approvalRequired =
    !input.dryRun && input.quality.requireApprovalBeforePublish && !input.skip.approval;
  const publishAllowedByApproval =
    !input.quality.requireApprovalBeforePublish || input.allowUnreviewedPublish || approval?.approved === true;
  const contentApproved =
    approvalRequired
      ? approval?.approved === true
      : input.quality.requireApprovalBeforePublish
        ? input.allowUnreviewedPublish && !input.dryRun
        : !input.dryRun;
  const shouldPublish =
    input.publish &&
    !input.dryRun &&
    publishAllowedByApproval &&
    latestEdited !== undefined &&
    latestCheck?.passed === true &&
    (input.skip.scoring || latestScore?.passed === true);

  return (
    <Workflow name="release-content">
      <Sequence>
        <Task id="probe-release" output={outputs.probe}>
          {() => probeRelease(input)}
        </Task>

        {probe ? (
          <Task id="collect-context" output={outputs.collectedContext}>
            {() => collectReleaseContext(input, probe)}
          </Task>
        ) : null}

        {probe && context ? (
          <Task
            id="analyze-release"
            output={outputs.releaseAnalysis}
            agent={input.skip.analyze ? undefined : agents.research}
            heartbeatTimeoutMs={900_000}
          >
            {input.skip.analyze
              ? () => manualAnalysis(input, probe, context)
              : (
                  <AnalyzeReleasePrompt
                    probe={probe}
                    context={context}
                    manualContext={input.releaseContext}
                    globalAdditional={input.additionalPrompts.global}
                    additional={input.additionalPrompts.analyzeRelease}
                  />
                )}
          </Task>
        ) : null}

        {analysis ? (
          <Task id="select-template" output={outputs.templateSelection}>
            {() => {
              if (input.skip.templateSelection && !input.template.forceTemplateId) {
                throw new Error("skip.templateSelection requires template.forceTemplateId");
              }
              return chooseTemplate(analysis, input.template);
            }}
          </Task>
        ) : null}

        {probe && analysis && selected ? (
          <Task id="draft-content-brief" output={outputs.contentBrief}>
            {() => buildContentBrief(input, probe, analysis, selected)}
          </Task>
        ) : null}

        {probe && analysis && selected && brief ? (
          <Parallel id="draft-channel-content" maxConcurrency={3}>
            <Task
              id="draft-changelog"
              output={outputs.changelogDraft}
              agent={contentAgent}
              skipIf={!input.channels.changelog || input.skip.changelog}
              heartbeatTimeoutMs={900_000}
            >
              <DraftChangelogPrompt
                probe={probe}
                analysis={analysis}
                template={selected}
                brief={brief}
                globalAdditional={input.additionalPrompts.global}
                additional={input.additionalPrompts.changelog}
              />
            </Task>

            <Task
              id="draft-thread"
              output={outputs.threadDraft}
              agent={contentAgent}
              skipIf={!input.channels.tweetThread || input.skip.tweetThread}
              heartbeatTimeoutMs={900_000}
            >
              <DraftThreadPrompt
                probe={probe}
                analysis={analysis}
                template={selected}
                brief={brief}
                styleRef={context?.priorThreads.map((entry) => entry.excerpt).join("\n\n---\n\n")}
                globalAdditional={input.additionalPrompts.global}
                additional={input.additionalPrompts.tweetThread}
                maxTweets={input.tweetThread.maxTweets}
                maxChars={input.tweetThread.maxChars}
                includeThreadNumbering={input.tweetThread.includeThreadNumbering}
                includeEmojis={input.tweetThread.includeEmojis}
                ctaUrl={input.tweetThread.ctaUrl}
              />
            </Task>

            <Sequence skipIf={!input.channels.blogPost || input.skip.blogPost}>
              <Task
                id="draft-blog-outline"
                output={outputs.blogOutline}
                agent={contentAgent}
                heartbeatTimeoutMs={900_000}
              >
                <DraftBlogOutlinePrompt
                  probe={probe}
                  analysis={analysis}
                  template={selected}
                  brief={brief}
                  globalAdditional={input.additionalPrompts.global}
                  additional={input.additionalPrompts.blogPost}
                  targetWords={input.blogPost.targetWords}
                />
              </Task>

              <Task
                id="draft-blog"
                output={outputs.blogDraft}
                agent={contentAgent}
                heartbeatTimeoutMs={900_000}
                needs={{ outline: "draft-blog-outline" }}
                deps={{ outline: outputs.blogOutline }}
              >
                {(deps) => (
                  <DraftBlogPrompt
                    probe={probe}
                    analysis={analysis}
                    template={selected}
                    brief={brief}
                    outline={deps.outline}
                    globalAdditional={input.additionalPrompts.global}
                    additional={input.additionalPrompts.blogPost}
                    targetWords={input.blogPost.targetWords}
                    includeCodeExample={input.blogPost.includeCodeExample}
                    includeMigrationNotes={input.blogPost.includeMigrationNotes}
                    frontmatter={input.blogPost.frontmatter}
                  />
                )}
              </Task>
            </Sequence>
          </Parallel>
        ) : null}

        {probe && analysis && selected && brief && draftsReady ? (
          <Loop
            id="quality-loop"
            until={qualityLoopDone}
            maxIterations={input.quality.maxRevisionLoops + 1}
            onMaxReached="return-last"
          >
            <Sequence>
              <Task
                id="edit-content"
                output={outputs.editedContent}
                agent={contentAgent}
                heartbeatTimeoutMs={900_000}
              >
                <EditContentPrompt
                  probe={probe}
                  analysis={analysis}
                  template={selected}
                  brief={brief}
                  changelog={changelog ?? null}
                  thread={thread ?? null}
                  blog={blog ?? null}
                  previousContent={latestEdited ?? null}
                  previousScore={latestScore ?? null}
                  globalAdditional={input.additionalPrompts.global}
                  additional={input.additionalPrompts.editor}
                />
              </Task>

              <Task
                id="claim-check"
                output={outputs.deterministicCheck}
                needs={{ edited: "edit-content" }}
                deps={{ edited: outputs.editedContent }}
              >
                {(deps) => runDeterministicChecks({ input, analysis, content: deps.edited })}
              </Task>

              <Task
                id="score-content"
                output={outputs.scoreReport}
                agent={agents.review}
                skipIf={input.skip.scoring}
                needs={{ edited: "edit-content", deterministicCheck: "claim-check" }}
                deps={{ edited: outputs.editedContent, deterministicCheck: outputs.deterministicCheck }}
                heartbeatTimeoutMs={900_000}
              >
                {(deps) => (
                  <ScoreContentPrompt
                    minScore={input.quality.minScore}
                    analysis={analysis}
                    template={selected}
                    content={deps.edited}
                    deterministicCheck={deps.deterministicCheck}
                    globalAdditional={input.additionalPrompts.global}
                    additional={input.additionalPrompts.scorer}
                  />
                )}
              </Task>
            </Sequence>
          </Loop>
        ) : null}

        {probe && analysis && latestEdited ? (
          <Task
            id="render-media"
            output={outputs.media}
            skipIf={
              !input.channels.tweetThread ||
              input.skip.renderMedia ||
              !input.tweetThread.generateMedia
            }
          >
            {() =>
              renderMediaAssets({
                input,
                probe,
                analysis,
                brief,
                content: latestEdited,
              })}
          </Task>
        ) : null}

        {probe && analysis && selected && latestEdited && latestCheck ? (
          <Task
            id="write-preview-artifacts"
            output={outputs.artifacts}
            skipIf={input.skip.writePreviewArtifacts}
          >
            {() =>
              writePreviewArtifacts({
                input,
                probe,
                analysis,
                selected,
                content: latestEdited,
                check: latestCheck,
                score: latestScore,
                media,
              })}
          </Task>
        ) : null}

        {latestCheck && latestEdited ? (
          <Task id="quality-gate" output={outputs.qualityGate}>
            {() => enforceQualityGate({ input, check: latestCheck, score: latestScore })}
          </Task>
        ) : null}

        <Branch
          if={approvalRequired && latestEdited !== undefined && latestCheck?.passed === true && scorePassed}
          then={
            <Approval
              id="approve-content"
              output={outputs.approval}
              request={{
                title: `Approve Smithers release content for ${probe?.version ?? "release"}`,
                summary:
                  `Template: ${selected?.templateId ?? "unknown"}\n` +
                  `Score: ${latestScore?.score ?? "skipped"}\n` +
                  `Artifacts: ${artifacts?.artifactDir ?? "not written"}`,
                metadata: {
                  version: probe?.version,
                  template: selected?.templateId,
                  score: latestScore?.score,
                  artifactDir: artifacts?.artifactDir,
                },
              }}
              onDeny="continue"
            />
          }
          else={null}
        />

        {probe && latestCheck && (approval || !approvalRequired) ? (
          <Task id="record-approval-artifact" output={outputs.approvalRecord}>
            {() =>
              recordApprovalArtifact({
                input,
                probe,
                approved: contentApproved,
                note: approval?.note ?? null,
                artifacts,
                score: latestScore,
                check: latestCheck,
              })}
          </Task>
        ) : null}

        {latestEdited && latestCheck ? (
          <Branch
            if={shouldPublish}
            then={
              <Parallel id="publish-release-content" maxConcurrency={2}>
                <Task
                  id="publish-files"
                  output={outputs.publishResult}
                  skipIf={input.skip.publishBlog && input.skip.publishChangelog && input.skip.publishThreadFile}
                >
                  {() => {
                    if (!latestEdited || !probe) throw new Error("No edited content available to publish.");
                    return publishFiles({ input, probe, content: latestEdited, media });
                  }}
                </Task>

                <Task
                  id="post-x-thread"
                  output={outputs.publishResult}
                  skipIf={!input.channels.tweetThread || input.skip.publishX}
                  heartbeatTimeoutMs={900_000}
                >
                  {async () => {
                    if (!latestEdited) throw new Error("No edited content available to post.");
                    return postThread({ input, content: latestEdited });
                  }}
                </Task>
              </Parallel>
            }
            else={
              <Task id="record-not-published" output={outputs.publishResult}>
                {{
                  published: false,
                  dryRun: input.dryRun,
                  files: [],
                  tweetIds: [],
                  message: input.dryRun
                    ? "Dry run complete. Preview artifacts were written; no external side effects performed."
                    : "Publish skipped because publish=false, approval was not granted, or publish prerequisites were not met.",
                }}
              </Task>
            }
          />
        ) : null}

        {probe && publishResult ? (
          <Task
            id="commit-release-content"
            output={outputs.commitResult}
            agent={agents.midTier}
            skipIf={input.skip.autoCommit || input.dryRun || !publishResult.published}
            heartbeatTimeoutMs={300_000}
          >
            {`Commit any release-content files created by this workflow run.

Repository: ${process.cwd()}
Run ID: ${rawCtx.runId}
Version: ${probe.version}
Dry run: ${input.dryRun}
Publish requested: ${input.publish}
Artifact directory: ${artifacts?.artifactDir ?? "(none)"}
Publish files: ${JSON.stringify(publishResult.files ?? [])}

Rules:
- First run \`jj st\` and inspect the working copy.
- Only commit files created or modified by this release-content run, such as versioned marketing assets or published release-content files.
- Do not commit unrelated changes, package manager metadata, database files, logs, or ignored preview artifacts.
- Use explicit pathspecs with \`git add <path> ...\` and \`git commit <path> ...\`; never use \`git add -A\`, \`git add .\`, or blanket pathspecs.
- Use an emoji + Conventional Commit subject, and include this trailer:
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- If there are no matching working-copy changes, do not commit.

Return JSON:
{
  "committed": boolean,
  "commit": string | null,
  "message": "short summary of what happened"
}`}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
