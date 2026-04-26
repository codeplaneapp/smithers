// smithers-source: seeded
/** @jsxImportSource smithers-orchestrator */
import {
  Sequence,
  Task,
  type AgentLike,
  type OutputTarget,
} from "smithers-orchestrator";
import type { ScorersMap } from "@smithers-orchestrator/scorers";
import { LoopUntilScored } from "../LoopUntilScored";
import ExtractPromptInstructions from "../../prompts/extract-prompt.mdx";
import type { CachedPrompt, Stakes } from "./PromptCache";
import { rctfPromptSchema, type RctfPromptOutput } from "./rctfPromptSchema";
import { stakesToThreshold } from "./stakesToThreshold";

export type ExtractPromptProps = {
  idPrefix: string;
  /** If provided AND non-trivial, ExtractPrompt is a passthrough — no extraction. */
  prompt?: string;
  /** Cache hit produced by the caller. If provided, also a passthrough. */
  cached?: CachedPrompt;
  /** Where the extracted/passthrough draft is written. */
  output: OutputTarget;
  /** Drafter agent. */
  agent: AgentLike | AgentLike[];
  /** Default: "rctf". Other presets are reserved for follow-up. */
  schema?: "rctf" | "prd" | "freeform";
  /** Stakes label; resolves the default threshold. Override via `threshold`. */
  stakes?: Stakes;
  /** Explicit threshold; wins over `stakes`. */
  threshold?: number;
  /** Maximum extraction loop iterations. Default: 10. */
  maxTurns?: number;
  /** The latest draft's score (caller resolves via ctx.latest(output).score). */
  currentScore?: number | null;
  /** The latest draft itself (used to render the score banner / ratification prompt). */
  latestDraft?: RctfPromptOutput | null;
  /** Free-form context to pass to the drafter. */
  context?: string;
  /** Optional async observability scorer(s). Independent from gating. */
  scorers?: ScorersMap;
  /** When prompt/cache is a passthrough, anchor it under this id. */
  passthroughId?: string;
};

const MIN_TRIVIAL_LEN = 32;

/**
 * Shareable component that yields an extracted prompt under three modes:
 *
 *   1. Passthrough     — caller already has a non-trivial `prompt`.
 *   2. Cache hit       — caller resolved a `cached` entry by key.
 *   3. Extraction loop — Socratic Q&A until the agent's self-score >= threshold,
 *                        followed by human ratification with a score-aware banner.
 *
 * Cache I/O is the caller's responsibility (see `MarkdownPromptCache`).
 * The component is otherwise pure — it reads ctx-derived values from props.
 */
export function ExtractPrompt({
  idPrefix,
  prompt,
  cached,
  output,
  agent,
  schema = "rctf",
  stakes = "low",
  threshold,
  maxTurns = 10,
  currentScore,
  latestDraft,
  context = "",
  scorers,
  passthroughId,
}: ExtractPromptProps) {
  const resolvedThreshold = threshold ?? stakesToThreshold(stakes);

  if (typeof prompt === "string" && prompt.trim().length >= MIN_TRIVIAL_LEN) {
    return (
      <Sequence>
        <Task id={passthroughId ?? `${idPrefix}:provided`} output={output}>
          {emitProvided(prompt)}
        </Task>
      </Sequence>
    );
  }

  if (cached) {
    return (
      <Sequence>
        <Task id={passthroughId ?? `${idPrefix}:cached`} output={output}>
          {emitCached(cached)}
        </Task>
      </Sequence>
    );
  }

  const banner = renderScoreBanner(currentScore, resolvedThreshold, stakes);
  const draftId = `${idPrefix}:draft`;

  return (
    <Sequence>
      <LoopUntilScored
        idPrefix={`${idPrefix}:extract`}
        currentScore={currentScore ?? null}
        threshold={resolvedThreshold}
        maxIterations={maxTurns}
        onMaxReached="return-last"
      >
        <Task id={draftId} output={output} agent={agent} scorers={scorers}>
          <ExtractPromptInstructions
            contextBlock={context ? `## Context\n${context}` : ""}
            priorDraftBlock={renderPriorDraftBlock(latestDraft)}
            scoreBanner={banner}
            threshold={resolvedThreshold}
            stakes={stakes}
          />
        </Task>
      </LoopUntilScored>
    </Sequence>
  );
}

function emitProvided(prompt: string): RctfPromptOutput {
  return {
    prompt,
    structured: emptyStructured(),
    score: 1.0,
    scoreReason: "Provided directly by caller; no extraction performed.",
    nextQuestion: "",
    nextPrinciple: "none",
    resolved: true,
    overridden: false,
    overrideReason: null,
  };
}

function emitCached(cached: CachedPrompt): RctfPromptOutput {
  const structured = isStructured(cached.structured)
    ? cached.structured
    : emptyStructured();
  return {
    prompt: cached.prompt,
    structured,
    score: cached.score,
    scoreReason: `cached: ${cached.scoreReason}`,
    nextQuestion: "",
    nextPrinciple: "none",
    resolved: true,
    overridden: cached.overridden,
    overrideReason: null,
  };
}

function emptyStructured(): RctfPromptOutput["structured"] {
  return {
    role: "",
    context: "",
    task: "",
    format: "",
    constraints: [],
    successCriteria: [],
    outOfScope: [],
  };
}

function isStructured(s: unknown): s is RctfPromptOutput["structured"] {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.role === "string" &&
    typeof o.context === "string" &&
    typeof o.task === "string" &&
    typeof o.format === "string"
  );
}

function renderScoreBanner(
  score: number | null | undefined,
  threshold: number,
  stakes: Stakes,
): string {
  if (typeof score !== "number") {
    return `Score: pending. Threshold: ${threshold} (stakes: ${stakes}).`;
  }
  if (score >= threshold) {
    return `✅ Score ${score.toFixed(2)} ≥ threshold ${threshold} (stakes: ${stakes}). I think this is ready.`;
  }
  return `⚠ Score ${score.toFixed(2)} < threshold ${threshold} (stakes: ${stakes}). Not yet ready by my judgment.`;
}

function renderPriorDraftBlock(draft: RctfPromptOutput | null | undefined): string {
  if (!draft) return "";
  return [
    "## Prior draft",
    "```json",
    JSON.stringify(draft, null, 2),
    "```",
    "",
    "Refine this draft. If a slot is already strongly filled, leave it.",
    "Identify the weakest slot and ask one Socratic question to improve it.",
  ].join("\n");
}

export { rctfPromptSchema };
