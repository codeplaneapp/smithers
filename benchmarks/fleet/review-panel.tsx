// smithers-source: benchmark-fleet
// smithers-display-name: Review Panel (Codex + Opus)
// smithers-description: A benchmark review stage as a PANEL: independent reviewers (Codex + Opus) judge the same implementation in parallel, and their verdicts aggregate to one decision. Reviewers never implement. Drop-in replacement for a single-reviewer harness stage.
// smithers-tags: benchmark, review, panel, fleet
/** @jsxImportSource smthrs */
import { Parallel, Sequence, Task, createSmithers } from "smthrs";
import { z } from "zod/v4";
import { buildReviewPanel } from "./buildReviewPanel";

const inputSchema = z.object({
  spec: z.string().describe("What the implementation was supposed to do (the requirements/roadmap)."),
  diff: z.string().describe("The implementation to review (a unified diff or a commit range summary)."),
  cwd: z.string().optional(),
  includeSonnet: z.boolean().default(false).describe("Add a third Sonnet reviewer."),
});

const verdictSchema = z.object({
  reviewer: z.string(),
  approved: z.boolean(),
  blockers: z.array(z.string()),
  notes: z.string(),
});
const decisionSchema = z.object({
  approved: z.boolean(),
  blockers: z.array(z.string()),
  reviewers: z.number(),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  verdict: verdictSchema,
  decision: decisionSchema,
});

function reviewPrompt(reviewer: string, spec: string, diff: string): string {
  return [
    `You are reviewer "${reviewer}" on an independent review panel. Judge ONLY — do not implement or edit.`,
    "Decide whether the implementation correctly and completely satisfies the spec, and list concrete blockers.",
    "",
    "# Spec",
    spec,
    "",
    "# Implementation to review",
    diff,
    "",
    `Output { reviewer: "${reviewer}", approved, blockers: string[], notes }.`,
  ].join("\n");
}

export default smithers((ctx) => {
  const input = ctx.input;
  const panel = buildReviewPanel({ cwd: input?.cwd, includeSonnet: input?.includeSonnet });
  const labels = ["codex", "opus", "sonnet"].slice(0, panel.length);
  const verdicts = (ctx.outputs.verdict ?? []) as Array<z.infer<typeof verdictSchema>>;

  return (
    <Workflow name="review-panel">
      <Sequence>
        <Parallel maxConcurrency={panel.length}>
          {panel.map((agent, i) => (
            <Task
              key={`review:${labels[i]}`}
              id={`review:${labels[i]}`}
              agent={agent}
              output={outputs.verdict}
              continueOnFail
              timeoutMs={20 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {reviewPrompt(labels[i], input?.spec ?? "", input?.diff ?? "")}
            </Task>
          ))}
        </Parallel>
        <Task id="decision" output={outputs.decision}>
          {() => ({
            approved: verdicts.length > 0 && verdicts.every((v) => v.approved),
            blockers: verdicts.flatMap((v) => v.blockers),
            reviewers: verdicts.length,
          })}
        </Task>
      </Sequence>
    </Workflow>
  );
});
