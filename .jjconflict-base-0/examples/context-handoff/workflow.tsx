/** @jsxImportSource smithers-orchestrator */
/**
 * Durable "/clear": a context handoff.
 *
 * Agents perform best in the smart zone (under ~200k tokens of context, ideally
 * under ~100k). A long-running loop accumulates context the way a chat session
 * does, and once it drifts out of the smart zone every later turn gets worse.
 * The fix a human does by hand is `/clear`: drop the accumulated residue, keep
 * the few facts that still matter, start fresh.
 *
 * This workflow does that automatically and durably. The pieces:
 *
 *   <Aspects tokenBudget>        a hard token ceiling for the subtree. The
 *                                engine enforces it at task dispatch; a breach
 *                                throws ASPECT_BUDGET_EXCEEDED.
 *   <TryCatchFinally>            an error boundary that catches exactly that
 *                                code and renders the catch branch instead of
 *                                failing the run.
 *   <ContinueAsNew state={...}>  the catch branch. It closes this run and opens
 *                                a fresh one carrying ONLY the distilled state,
 *                                so the new run starts back inside the smart
 *                                zone with no residue.
 *   <Loop>                       the little while loop that does the work. Each
 *                                pass makes one increment of progress until the
 *                                goal is met.
 *
 * Run the graph without executing it:
 *
 *   bunx smithers-orchestrator graph examples/context-handoff/workflow.tsx --input '{}'
 *
 * The DAG includes the catch branch, so the render proves the whole handoff
 * wiring compiles.
 */

import { createSmithers, ClaudeCodeAgent } from "smithers-orchestrator";
// In-repo, "smithers-orchestrator" resolves to a limited examples entry that
// does not re-export <Aspects>/<TryCatchFinally>; import them from the
// components package directly. End-user code can import both from
// "smithers-orchestrator".
import { Aspects, TryCatchFinally } from "@smithers-orchestrator/components";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";

const here = dirname(fileURLToPath(import.meta.url));

/** The minimal context we carry across a handoff. This, and only this, is what
 *  survives a `/clear`: the goal, which generation we are on, the last summary,
 *  and a short list of durable learnings (distilled wrong paths, not raw logs). */
type DistilledState = {
  goal: string;
  generation: number;
  lastSummary: string;
  learnings: string[];
};

export const schemas = {
  // One increment of work. `learnings` are distilled facts worth carrying
  // forward ("tried X, failed because Y"); `done` ends the loop.
  step: z.object({
    summary: z.string().default(""),
    learnings: z.array(z.string()).default([]),
    done: z.boolean().default(false),
  }),
};

// A local, gitignored DB next to this file so `smithers graph` never touches
// the project's smithers.db.
const api = createSmithers(schemas, { dbPath: join(here, "smithers.db") });
const { smithers, Workflow, Task, Loop, ContinueAsNew, outputs } = api;

// Autonomous agent: bypass flags on, no pinned cwd (that would override a
// <Worktree>). Graph rendering does not run the agent; these are the real
// flags a live run needs.
const worker = new ClaudeCodeAgent({
  model: "claude-opus-4-8",
  permissionMode: "bypassPermissions",
  dangerouslySkipPermissions: true,
});

const MAX_CONTEXT_TOKENS = 150_000;

export default smithers((ctx) => {
  // ctx.input fields arrive raw-or-null, so coalesce every read. The carried
  // state arrives under the continuation envelope on a handoff; on a cold start
  // it is absent and we read the top-level goal instead.
  const input = (ctx.input ?? {}) as {
    goal?: string | null;
    __smithersContinuation?: { payload?: Partial<DistilledState> | null } | null;
  };
  const carried = input.__smithersContinuation?.payload ?? null;
  const goal = carried?.goal ?? input.goal ?? "Make the failing test suite pass.";
  const generation = (carried?.generation ?? 0) + 1;

  // Read this generation's progress out of typed outputs (empty on a fresh
  // render). The loop is done when the last step says so.
  const steps = ctx.outputs.step ?? [];
  const lastStep = steps[steps.length - 1];
  const done = lastStep?.done === true;

  // Distill the state we would hand off: the goal, the next generation number,
  // the latest summary, and the last 10 learnings. Capped on purpose, so the
  // fresh run starts small and back inside the smart zone.
  const distilled: DistilledState = {
    goal,
    generation,
    lastSummary: lastStep?.summary ?? carried?.lastSummary ?? "",
    learnings: [...(carried?.learnings ?? []), ...(lastStep?.learnings ?? [])].slice(-10),
  };

  const prompt = [
    `Goal: ${goal}`,
    carried
      ? `Fresh context, generation ${generation}. Prior summary: ${distilled.lastSummary || "(none)"}.`
      : "Fresh start.",
    distilled.learnings.length
      ? `Known so far:\n${distilled.learnings.map((l) => `- ${l}`).join("\n")}`
      : "",
    "Make one increment of progress. Report a short summary, any durable learnings (distill wrong paths to 'tried X, failed because Y'), and set done=true only when the goal is fully met.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <Workflow name="context-handoff">
      <Aspects tokenBudget={{ max: MAX_CONTEXT_TOKENS, onExceeded: "fail" }}>
        <TryCatchFinally
          catchErrors={["ASPECT_BUDGET_EXCEEDED"]}
          catch={<ContinueAsNew state={distilled} />}
          try={
            <Loop id="work" until={done} maxIterations={50}>
              <Task id="step" output={outputs.step} agent={worker}>
                {prompt}
              </Task>
            </Loop>
          }
        />
      </Aspects>
    </Workflow>
  );
});
