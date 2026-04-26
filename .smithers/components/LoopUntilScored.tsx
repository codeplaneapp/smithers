// smithers-source: seeded
/** @jsxImportSource smithers-orchestrator */
import { Loop } from "smithers-orchestrator";

export type LoopUntilScoredProps = {
  idPrefix: string;
  /**
   * The current score for whatever the loop body produces, read by the
   * caller from `ctx.outputMaybe(...).score`. May be:
   *
   *   - `number` — score is ready
   *   - `null` / `undefined` — score is missing/pending (loop continues)
   */
  currentScore: number | null | undefined;
  /** Score >= threshold ends the loop. Use stakesToThreshold() for sensible defaults. */
  threshold: number;
  /** Maximum iterations regardless of score. Default: 5. */
  maxIterations?: number;
  /** What to do at maxIterations without crossing threshold. Default: return-last. */
  onMaxReached?: "fail" | "return-last";
  /**
   * Behavior when score is null/undefined.
   *   - "continue" (default): keep looping
   *   - "stop": exit the loop (treat missing score as terminal)
   */
  onPending?: "continue" | "stop";
  children?: React.ReactNode;
};

/**
 * Loop a child task until its score crosses a threshold.
 *
 * The caller resolves the score from `ctx` and passes it as `currentScore`.
 * This component is a thin wrapper around `<Loop>` — the value-add is making
 * the score-gating contract explicit and reusable.
 *
 * ```tsx
 * const draft = ctx.outputMaybe(outputs.draft, { nodeId: "extract:draft" });
 * return (
 *   <LoopUntilScored
 *     idPrefix="extract"
 *     currentScore={draft?.score ?? null}
 *     threshold={stakesToThreshold(stakes)}
 *     maxIterations={10}
 *   >
 *     <Task id="extract:draft" output={outputs.draft} agent={agent}>
 *       <ExtractPromptInstructions />
 *     </Task>
 *   </LoopUntilScored>
 * );
 * ```
 */
export function LoopUntilScored({
  idPrefix,
  currentScore,
  threshold,
  maxIterations = 5,
  onMaxReached = "return-last",
  onPending = "continue",
  children,
}: LoopUntilScoredProps) {
  const hasScore = typeof currentScore === "number";
  const until = hasScore
    ? currentScore >= threshold
    : onPending === "stop";
  return (
    <Loop
      id={`${idPrefix}:loop`}
      until={until}
      maxIterations={maxIterations}
      onMaxReached={onMaxReached}
    >
      {children}
    </Loop>
  );
}
