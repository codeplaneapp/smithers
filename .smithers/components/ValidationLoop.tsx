// smithers-source: seeded
/** @jsxImportSource smithers-orchestrator */
import { Sequence, Loop, Task, type AgentLike } from "smithers-orchestrator";
import { z } from "zod/v4";
import { Review, ReviewPanel, type Panelist } from "~/components/Review";
import ImplementPrompt from "~/prompts/implement.mdx";
import ValidatePrompt from "~/prompts/validate.mdx";

export const implementOutputSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  allTestsPassing: z.boolean().default(true),
});
export const validateOutputSchema = z.object({
  summary: z.string(),
  allPassed: z.boolean().default(true),
  failingSummary: z.string().nullable().default(null),
});

export type ValidationLoopProps = {
  /** JSX identity when a caller renders multiple validation loops from a map. */
  key?: string | number | bigint | null;
  idPrefix: string;
  prompt: unknown;
  implementAgents: AgentLike[];
  /** Reviewers — each may be an agent, a failover chain, or a PanelistConfig. */
  reviewAgents: Panelist[];
  validateAgents?: AgentLike[];
  /**
   * When true, the review step is a synthesized PANEL: parallel panelists feed a
   * moderator that produces one verdict (read it with `reviewGate`, and register
   * `reviewSynthesis: reviewSynthesisSchema` in createSmithers). Default is the
   * plain parallel `Review` (per-reviewer verdicts via `ctx.outputs.review`).
   */
  synthesizeReview?: boolean;
  /** Moderator for the synthesized review panel; defaults to the shared synthesizer (usually Codex, with Opus fallback). An AgentLike[] is a failover chain. Only used when synthesizeReview is true. */
  reviewModerator?: AgentLike | AgentLike[];
  /**
   * Mount the review step only when true (default true = always review).
   * Pass the current iteration's validation verdict to skip reviewing code
   * that validation already rejected — each skipped round saves one agent
   * session per reviewer. The loop re-renders when the validate output lands,
   * so the review step mounts within the same iteration once it passes.
   */
  reviewWhen?: boolean;
  /** Node ids that must complete before the first implementation attempt. */
  startAfter?: string[];
  feedback?: string | null;
  done?: boolean;
  maxIterations?: number;
};

type RawOutputRow = Record<string, unknown> & { nodeId?: string };

export type ValidationLoopStateOptions = {
  prefix: string;
  validateNodeId?: string;
  reviewChannel?: string;
  reviewNodeId?: string;
  maxIterations?: number;
};

export type ValidationLoopState = {
  validationPassed: boolean;
  reviewApproved: boolean;
  paired: boolean;
  done: boolean;
  feedback: string | null;
  attempts: number;
  exhausted: boolean;
};

function rawRows(
  ctx: { outputs?: Record<string, unknown[]> | ((channel: string) => unknown[]) },
  channel: string,
): RawOutputRow[] {
  const value = typeof ctx.outputs === "function" ? ctx.outputs(channel) : ctx.outputs?.[channel];
  return Array.isArray(value)
    ? value.filter((row): row is RawOutputRow => typeof row === "object" && row !== null)
    : [];
}

function rowVersion(row: RawOutputRow): [number, number] {
  const iteration = Number.isFinite(Number(row.iteration)) ? Number(row.iteration) : 0;
  const iterationCount = Number.isFinite(Number(row.iterationCount)) ? Number(row.iterationCount) : iteration;
  return [iterationCount, iteration];
}

function latestRaw(rows: RawOutputRow[], nodeId: string): RawOutputRow | undefined {
  return rows
    .filter((row) => row.nodeId === nodeId)
    .reduce<RawOutputRow | undefined>((best, row) => {
      if (!best) return row;
      const current = rowVersion(row);
      const previous = rowVersion(best);
      return current[0] > previous[0] || (current[0] === previous[0] && current[1] >= previous[1]) ? row : best;
    }, undefined);
}

/** Fail-closed validation/review state, paired to the same loop iteration. */
export function validationLoopState(
  ctx: { outputs?: Record<string, unknown[]> | ((channel: string) => unknown[]) },
  {
    prefix,
    validateNodeId = `${prefix}:validate`,
    reviewChannel = "reviewSynthesis",
    reviewNodeId = `${prefix}:review-moderator`,
    maxIterations = 3,
  }: ValidationLoopStateOptions,
): ValidationLoopState {
  const validate = latestRaw(rawRows(ctx, "validate"), validateNodeId);
  const review = latestRaw(rawRows(ctx, reviewChannel), reviewNodeId);
  const paired =
    validate !== undefined &&
    review !== undefined &&
    rowVersion(validate)[0] === rowVersion(review)[0] &&
    rowVersion(validate)[1] === rowVersion(review)[1];
  const validationPassed = validate?.allPassed === true;
  const reviewApproved = paired && review?.approved === true;
  const done = validationPassed && reviewApproved;
  const implementRows = rawRows(ctx, "implement").filter((row) => row.nodeId === `${prefix}:implement`);
  const attempts = implementRows.length;
  const latestImplement = latestRaw(implementRows, `${prefix}:implement`);
  const validateVersion = validate ? rowVersion(validate) : null;
  const implementVersion = latestImplement ? rowVersion(latestImplement) : null;
  const hasCurrentValidation =
    validateVersion !== null &&
    implementVersion !== null &&
    (validateVersion[0] > implementVersion[0] ||
      (validateVersion[0] === implementVersion[0] && validateVersion[1] >= implementVersion[1]));
  // Do not declare exhaustion in the middle of the last attempt: implement
  // output lands before validation, and a green validation lands before its
  // same-iteration review. The explicit failure node may mount only after the
  // final attempt has a terminal red validation or a paired review verdict.
  const finalAttemptComplete = hasCurrentValidation && (validate?.allPassed === false || paired);

  const feedback: string[] = [];
  if (validate?.allPassed === false) {
    const detail = validate.failingSummary ?? validate.summary;
    if (typeof detail === "string" && detail.length > 0) feedback.push(`VALIDATION FAILED:\n${detail}`);
  }
  if (paired && review?.approved === false) {
    if (typeof review.feedback === "string" && review.feedback.length > 0) {
      feedback.push(`REVIEW PANEL REJECTED:\n${review.feedback}`);
    }
    if (Array.isArray(review.issues)) {
      for (const rawIssue of review.issues) {
        if (typeof rawIssue !== "object" || rawIssue === null) continue;
        const issue = rawIssue as Record<string, unknown>;
        feedback.push(
          `  [${String(issue.severity ?? "issue")}] ${String(issue.title ?? "Untitled")}: ${String(issue.description ?? "")}${issue.file ? ` (${String(issue.file)})` : ""}`,
        );
      }
    }
  }
  return {
    validationPassed,
    reviewApproved,
    paired,
    done,
    feedback: feedback.length > 0 ? feedback.join("\n\n") : null,
    attempts,
    exhausted: !done && attempts >= maxIterations && finalAttemptComplete,
  };
}

export function ValidationLoop({
  idPrefix,
  prompt,
  implementAgents,
  reviewAgents,
  validateAgents,
  synthesizeReview = false,
  reviewModerator,
  reviewWhen = true,
  startAfter,
  feedback,
  done = false,
  maxIterations = 3,
}: ValidationLoopProps) {
  const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt ?? null);
  return (
    <Loop id={`${idPrefix}:loop`} until={done} maxIterations={maxIterations} onMaxReached="return-last">
      <Sequence>
        <Task
          id={`${idPrefix}:implement`}
          output={implementOutputSchema}
          agent={implementAgents}
          dependsOn={startAfter}
          timeoutMs={1_800_000}
          heartbeatTimeoutMs={600_000}
        >
          <ImplementPrompt
            prompt={
              feedback ? `${promptText}\n\n---\nPREVIOUS ATTEMPT FEEDBACK (fix these issues):\n${feedback}` : promptText
            }
          />
        </Task>
        <Task
          id={`${idPrefix}:validate`}
          output={validateOutputSchema}
          dependsOn={[`${idPrefix}:implement`]}
          agent={validateAgents && validateAgents.length > 0 ? validateAgents : implementAgents}
          timeoutMs={1_800_000}
          heartbeatTimeoutMs={600_000}
        >
          <ValidatePrompt prompt={promptText} />
        </Task>
        {!reviewWhen ? null : synthesizeReview ? (
          <ReviewPanel
            idPrefix={`${idPrefix}:review`}
            prompt={promptText}
            agents={reviewAgents}
            moderator={reviewModerator}
          />
        ) : (
          <Review idPrefix={`${idPrefix}:review`} prompt={promptText} agents={reviewAgents} />
        )}
      </Sequence>
    </Loop>
  );
}
