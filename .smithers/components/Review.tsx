// smithers-source: seeded
/** @jsxImportSource smithers-orchestrator */
import { Panel, Parallel, Task, type AgentLike } from "smithers-orchestrator";
import { z } from "zod/v4";
import { synthesizer as defaultSynthesizer } from "./roles";
import ReviewPrompt from "../prompts/review.mdx";

// A reviewer entry: a single agent, a failover chain, or a labelled config
// (mirrors the library PanelistConfig, inlined to avoid a type-only import).
type PanelistConfig = { agent: AgentLike | AgentLike[]; role?: string; label?: string };
export type Panelist = AgentLike | AgentLike[] | PanelistConfig;
function panelistAgent(entry: Panelist): AgentLike | AgentLike[] {
  return !Array.isArray(entry) && typeof entry === "object" && "agent" in entry ? entry.agent : entry;
}

const reviewIssueSchema = z.object({
  severity: z.enum(["critical", "major", "minor", "nit"]),
  title: z.string(),
  file: z.string().nullable().default(null),
  description: z.string(),
});

// One reviewer's verdict — produced by each panelist.
export const reviewOutputSchema = z.object({
  reviewer: z.string(),
  approved: z.boolean(),
  feedback: z.string(),
  issues: z.array(reviewIssueSchema).default([]),
});

// The MODERATOR's synthesized verdict — one consolidated decision merged from
// every panelist. MUST be a distinct schema object from reviewOutputSchema so
// it resolves to its own output channel (channels are keyed by schema identity).
export const reviewSynthesisSchema = z.object({
  approved: z
    .boolean()
    .describe(
      "true ONLY if there are no remaining critical or major issues across all reviewers",
    ),
  feedback: z
    .string()
    .describe("consolidated, actionable feedback merged from every reviewer"),
  issues: z.array(reviewIssueSchema).default([]),
});

type ReviewProps = {
  idPrefix: string;
  prompt: unknown;
  agents: Panelist[];
};

/**
 * Legacy parallel review: N reviewers, no synthesis. Kept for back-compat;
 * prefer <ReviewPanel> for a synthesized verdict.
 */
export function Review({ idPrefix, prompt, agents }: ReviewProps) {
  const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt ?? null);
  return (
    <Parallel>
      {agents.map((entry, index) => (
        <Task
          key={`${idPrefix}:${index}`}
          id={`${idPrefix}:${index}`}
          output={reviewOutputSchema}
          agent={panelistAgent(entry)}
          continueOnFail
          timeoutMs={1_800_000}
          heartbeatTimeoutMs={600_000}
        >
          <ReviewPrompt reviewer={`reviewer-${index + 1}`} prompt={promptText} />
        </Task>
      ))}
    </Parallel>
  );
}

type ReviewPanelProps = {
  idPrefix: string;
  prompt: unknown;
  /** Panelist reviewers (run in parallel). Each may be an agent, a failover chain, or a config. */
  agents: Panelist[];
  /** The moderator that synthesizes the panelists into one verdict; defaults to the shared synthesizer (usually Codex, with Opus fallback). An AgentLike[] is a failover chain. */
  moderator?: AgentLike | AgentLike[];
};

/**
 * <ReviewPanel> — a model-diverse review PANEL that gets SYNTHESIZED. Each
 * panelist in `agents` reviews in parallel (writing reviewOutputSchema), then
 * the moderator merges them into a single reviewSynthesisSchema verdict at the
 * node `${idPrefix}-moderator`. Read that verdict with `reviewGate`.
 */
export function ReviewPanel({ idPrefix, prompt, agents, moderator = defaultSynthesizer }: ReviewPanelProps) {
  const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt ?? null);
  return (
    <Panel
      id={idPrefix}
      panelists={agents}
      moderator={moderator}
      panelistOutput={reviewOutputSchema}
      moderatorOutput={reviewSynthesisSchema}
      strategy="synthesize"
      panelistTaskProps={{ continueOnFail: true, timeoutMs: 1_800_000, heartbeatTimeoutMs: 600_000 }}
      moderatorTaskProps={{ continueOnFail: true, timeoutMs: 1_800_000, heartbeatTimeoutMs: 600_000 }}
    >
      <ReviewPrompt reviewer="review panelist" prompt={promptText} />
    </Panel>
  );
}

export type ReviewGate = {
  /** Whether the moderator has produced a verdict yet. */
  hasVerdict: boolean;
  /** Whether the synthesized verdict approved the change. */
  approved: boolean;
  /** Consolidated rejection feedback (null when approved or no verdict yet). */
  feedback: string | null;
};

/**
 * Read a ReviewPanel's synthesized verdict from the workflow context. The
 * workflow must register `reviewSynthesis: reviewSynthesisSchema` in
 * createSmithers. `nodeId` is the moderator node (`${idPrefix}-moderator`).
 */
export function reviewGate(
  ctx: { outputMaybe: (channel: string, opts: { nodeId: string }) => unknown },
  nodeId: string,
): ReviewGate {
  const verdict = ctx.outputMaybe("reviewSynthesis", { nodeId }) as
    | z.infer<typeof reviewSynthesisSchema>
    | undefined;
  const approved = verdict?.approved === true;
  let feedback: string | null = null;
  if (verdict && !approved) {
    const parts: string[] = [];
    if (verdict.feedback) parts.push(verdict.feedback);
    for (const issue of verdict.issues ?? []) {
      parts.push(`  [${issue.severity}] ${issue.title}: ${issue.description}${issue.file ? ` (${issue.file})` : ""}`);
    }
    feedback = parts.length > 0 ? parts.join("\n") : null;
  }
  return { hasVerdict: verdict !== undefined, approved, feedback };
}
