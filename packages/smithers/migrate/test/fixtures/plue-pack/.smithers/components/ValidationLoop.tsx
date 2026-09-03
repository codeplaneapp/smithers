// smithers-source: seeded
/** @jsxImportSource smithers-orchestrator */
import { Sequence, Loop, Task, type AgentLike } from "smithers-orchestrator";
import { z } from "zod/v4";
import { Review, ReviewPanel, type Panelist } from "./Review";
import ImplementPrompt from "../prompts/implement.mdx";
import ValidatePrompt from "../prompts/validate.mdx";

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
  feedback?: string | null;
  done?: boolean;
  maxIterations?: number;
};

export function ValidationLoop({
  idPrefix,
  prompt,
  implementAgents,
  reviewAgents,
  validateAgents,
  synthesizeReview = false,
  reviewModerator,
  reviewWhen = true,
  feedback,
  done = false,
  maxIterations = 3,
}: ValidationLoopProps) {
  const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt ?? null);
  return (
    <Loop id={`${idPrefix}:loop`} until={done} maxIterations={maxIterations} onMaxReached="fail">
      <Sequence>
        <Task id={`${idPrefix}:implement`} output={implementOutputSchema} agent={implementAgents} timeoutMs={1_800_000} heartbeatTimeoutMs={600_000}>
          <ImplementPrompt prompt={feedback
            ? `${promptText}\n\n---\nPREVIOUS ATTEMPT FEEDBACK (fix these issues):\n${feedback}`
            : promptText} />
        </Task>
        <Task id={`${idPrefix}:validate`} output={validateOutputSchema} agent={validateAgents && validateAgents.length > 0
          ? validateAgents
          : implementAgents} timeoutMs={1_800_000} heartbeatTimeoutMs={600_000}>
          <ValidatePrompt prompt={promptText} />
        </Task>
        {!reviewWhen
          ? null
          : synthesizeReview
            ? <ReviewPanel idPrefix={`${idPrefix}:review`} prompt={promptText} agents={reviewAgents} moderator={reviewModerator} />
            : <Review idPrefix={`${idPrefix}:review`} prompt={promptText} agents={reviewAgents} />}
      </Sequence>
    </Loop>
  );
}
