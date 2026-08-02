// smithers-source: benchmark-fleet
// smithers-display-name: Self-Improve (eval hill-climb)
// smithers-description: Durable keep-if-better loop over a smithers eval suite. Each round snapshots a target file, an Opus agent proposes one improvement, re-runs the eval, and keeps the edit only if the objective strictly improves (else reverts). A holdout guard blocks overfitting. Meant to lift a benchmark scaffold's prompts/workflow over time.
// smithers-tags: eval, optimize, self-improve, fleet
/** @jsxImportSource smthrs */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { ClaudeCodeAgent, Loop, Sequence, Task, createSmithers } from "smthrs";
import { z } from "zod/v4";

// The target is the file we hill-climb (a prompt .mdx, a workflow .tsx, or an
// agent config). `cases` is the eval JSONL; `evalWorkflow` is the workflow the
// eval runs. Objective is the eval pass-rate; a holdout suite guards against
// overfitting the dev cases.
const inputSchema = z.object({
  target: z.string().describe("File to improve (kept only if it raises the score)."),
  evalWorkflow: z.string().describe("Workflow the eval suite runs."),
  cases: z.string().describe("Dev eval cases (JSONL)."),
  holdout: z.string().optional().describe("Holdout cases; a kept edit must not regress these."),
  root: z.string().default("/tmp/self-improve-root").describe("Sandbox root for eval tool writes."),
  reportDir: z.string().default(".smithers/reports/self-improve").describe("Where eval reports land."),
  model: z.string().default("claude-opus-4-8").describe("Proposer model (Opus)."),
  minDelta: z.number().default(0.01).describe("Minimum score gain to keep an edit."),
  maxRounds: z.number().int().min(1).max(20).default(6),
  targetScore: z.number().min(0).max(1).default(1).describe("Stop early once the objective reaches this."),
  patience: z.number().int().min(1).max(6).default(2).describe("Stop after this many consecutive no-improvement rounds."),
});

const baselineResult = z.object({ score: z.number() });
const snapshotResult = z.object({ round: z.number(), original: z.string() });
const rescoreResult = z.object({ round: z.number(), candidateScore: z.number(), holdoutScore: z.number().nullable() });
const decideResult = z.object({ round: z.number(), score: z.number(), kept: z.boolean(), bestScore: z.number() });
const proposeResult = z.object({ rationale: z.string(), noChange: z.boolean().optional() });

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  baseline: baselineResult,
  snapshot: snapshotResult,
  rescore: rescoreResult,
  decide: decideResult,
  propose: proposeResult,
});

const SMITHERS = process.env.FLEET_SMITHERS ?? "smithers";

function evalScore(evalWorkflow: string, cases: string, root: string, report: string): number {
  mkdirSync(dirname(report), { recursive: true });
  spawnSync(
    SMITHERS,
    ["eval", evalWorkflow, "--cases", cases, "--suite", "self-improve", "--report", report, "--root", root, "--force"],
    { encoding: "utf8", stdio: "inherit", timeout: 50 * 60_000 },
  );
  try {
    const rep = JSON.parse(readFileSync(report, "utf8")) as { summary?: { passed?: number; total?: number } };
    const total = rep.summary?.total ?? 0;
    return total ? (rep.summary?.passed ?? 0) / total : 0;
  } catch {
    return 0;
  }
}

function proposePrompt(target: string, reportPath: string): string {
  return [
    "You are improving a Smithers benchmark scaffold so a fixed model scores higher on a held eval suite.",
    `TARGET FILE (edit this file in place — it is the only deliverable): ${target}`,
    `LATEST EVAL REPORT (read it for failing cases + reasons): ${reportPath}`,
    "",
    "Make ONE focused improvement to the target that should raise the eval pass-rate:",
    "- Read the target and the report's failing cases.",
    "- Edit the target file directly with your file tools.",
    "- Do NOT weaken or edit the eval cases, the tests, or the grader. Improve the SCAFFOLD, not the benchmark.",
    "- If the target already looks optimal for the failures, output noChange:true and edit nothing.",
    "Output { rationale, noChange? }.",
  ].join("\n");
}

export default smithers((ctx) => {
  const input = ctx.input;
  const cfg = {
    target: input?.target ?? "",
    evalWorkflow: input?.evalWorkflow ?? "",
    cases: input?.cases ?? "",
    holdout: input?.holdout,
    root: input?.root ?? "/tmp/self-improve-root",
    reportDir: input?.reportDir ?? ".smithers/reports/self-improve",
    model: input?.model ?? "claude-opus-4-8",
    minDelta: input?.minDelta ?? 0.01,
    maxRounds: input?.maxRounds ?? 6,
    targetScore: input?.targetScore ?? 1,
    patience: input?.patience ?? 2,
  };
  const proposer = new ClaudeCodeAgent({ model: cfg.model, yolo: true });

  const baselineRow = (ctx.outputs.baseline ?? [])[0] as z.infer<typeof baselineResult> | undefined;
  const rounds = (ctx.outputs.decide ?? []) as Array<z.infer<typeof decideResult>>;
  const round = rounds.length;
  const bestScore = rounds.length ? rounds[rounds.length - 1].bestScore : (baselineRow?.score ?? 0);
  const recentNoImprove = rounds.slice(-cfg.patience).filter((r) => !r.kept).length;
  const converged =
    bestScore >= cfg.targetScore || (rounds.length >= cfg.patience && recentNoImprove >= cfg.patience);

  const snapshots = (ctx.outputs.snapshot ?? []) as Array<z.infer<typeof snapshotResult>>;
  const rescores = (ctx.outputs.rescore ?? []) as Array<z.infer<typeof rescoreResult>>;
  const latestSnapshot = snapshots[snapshots.length - 1];
  const latestRescore = rescores[rescores.length - 1];
  const reportPath = join(cfg.reportDir, `round-${round}.json`);

  return (
    <Workflow name="self-improve">
      <Sequence>
        <Task id="baseline" output={outputs.baseline} heartbeatTimeoutMs={50 * 60_000}>
          {() => ({ score: evalScore(cfg.evalWorkflow, cfg.cases, cfg.root, join(cfg.reportDir, "baseline.json")) })}
        </Task>

        {baselineRow ? (
          <Loop until={converged} maxIterations={cfg.maxRounds} onMaxReached="return-last">
            <Sequence>
              <Task id="snapshot" output={outputs.snapshot}>
                {() => ({ round, original: readFileSync(cfg.target, "utf8") })}
              </Task>
              <Task id="propose" agent={proposer} output={outputs.propose} retries={1} continueOnFail timeoutMs={30 * 60_000} heartbeatTimeoutMs={12 * 60_000}>
                {proposePrompt(cfg.target, join(cfg.reportDir, round === 0 ? "baseline.json" : `round-${round - 1}.json`))}
              </Task>
              <Task id="rescore" output={outputs.rescore} heartbeatTimeoutMs={50 * 60_000}>
                {() => ({
                  round,
                  candidateScore: evalScore(cfg.evalWorkflow, cfg.cases, cfg.root, reportPath),
                  holdoutScore: cfg.holdout
                    ? evalScore(cfg.evalWorkflow, cfg.holdout, cfg.root, join(cfg.reportDir, `round-${round}-holdout.json`))
                    : null,
                })}
              </Task>
              <Task id="decide" output={outputs.decide}>
                {() => {
                  const candidate = latestRescore?.candidateScore ?? 0;
                  const holdoutOk = latestRescore?.holdoutScore == null || latestRescore.holdoutScore >= bestScore - 1e-9;
                  const improved = candidate > bestScore + cfg.minDelta && holdoutOk;
                  if (!improved && latestSnapshot) writeFileSync(cfg.target, latestSnapshot.original);
                  return { round, score: candidate, kept: improved, bestScore: improved ? candidate : bestScore };
                }}
              </Task>
            </Sequence>
          </Loop>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
