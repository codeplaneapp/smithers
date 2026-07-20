/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import type { z } from "zod";

import { agentsForRepo } from "../components/agents";
import { DEFAULT_SWEEPS, stableNodeId } from "../components/porting-rules";
import { standardScorers } from "../components/scorers";
import {
  sweepInputSchema,
  phaseDoneSchema,
  sweepReportSchema,
  sweepResultSchema,
  sweepSurveySchema,
} from "../components/schemas";
import SweepPrompt from "../prompts/sweep.mdx";

const { Workflow, Task, Sequence, Parallel, Loop, smithers, outputs } = createSmithers(
  {
    input: sweepInputSchema,
    sweepSurvey: sweepSurveySchema,
    sweepResult: sweepResultSchema,
    sweepReport: sweepReportSchema,
    output: phaseDoneSchema,
  },
  { dbPath: process.env.BUN_PORT_SMITHERS_DB ?? "examples/bun-port-smithers/.tmp/smithers.db" },
);

const sweepMemory = { kind: "workflow", id: "bun-port-sweeps" } as const;

export default smithers((ctx) => {
  type SweepSurvey = z.infer<typeof sweepSurveySchema>;
  type SweepResult = z.infer<typeof sweepResultSchema>;
  const agents = agentsForRepo(ctx.input.repo);
  const scorers = standardScorers(ctx.input.repo, 20 * 60_000);
  const survey = ctx.outputMaybe(outputs.sweepSurvey, { nodeId: "sweep:survey" }) as SweepSurvey | undefined;
  const report = ctx.outputMaybe(outputs.sweepReport, { nodeId: "sweep:report" }) as z.infer<typeof sweepReportSchema> | undefined;
  const sweeps = survey?.sweeps ?? [];
  const results = sweeps
    .map((sweep) => ctx.latest("sweepResult", `sweep:${stableNodeId(sweep.id)}`) as SweepResult | undefined)
    .filter((result): result is SweepResult => Boolean(result));
  const allSweepsDone = survey ? results.length >= survey.total : false;

  return (
    <Workflow name="bun-port-audit-sweeps">
      <Sequence>
        <Task id="sweep:survey" output={outputs.sweepSurvey}>
          {() => {
            const inputSweeps = ctx.input.sweeps ?? [];
            const selected = inputSweeps.length > 0 ? inputSweeps : DEFAULT_SWEEPS;
            return { sweeps: selected, total: selected.length };
          }}
        </Task>

        {survey ? (
          <Parallel maxConcurrency={Math.max(1, survey.total)}>
            {sweeps.map((sweep) => {
              const sweepId = stableNodeId(sweep.id);
              const previous = ctx.latest("sweepResult", `sweep:${sweepId}`) as SweepResult | undefined;
              return (
                <Loop
                  key={sweep.id}
                  id={`sweep:${sweepId}:loop`}
                  until={previous ? previous.skipped === 0 : false}
                  maxIterations={3}
                  onMaxReached="return-last"
                >
                  <Task
                    id={`sweep:${sweepId}`}
                    output={outputs.sweepResult}
                    agent={agents.sweepAgent}
                    timeoutMs={20 * 60_000}
                    scorers={scorers}
                    memory={{
                      recall: { namespace: sweepMemory, query: `${sweep.kind} ${sweep.pattern}`, topK: 8 },
                      remember: { namespace: sweepMemory, key: `sweep:${sweep.id}` },
                    }}
                  >
                    <SweepPrompt
                      repo={ctx.input.repo}
                      sweep={sweep}
                      previous={previous ?? null}
                      schema={sweepResultSchema}
                    />
                  </Task>
                </Loop>
              );
            })}
          </Parallel>
        ) : null}

        {survey && allSweepsDone ? (
          <Task id="sweep:report" output={outputs.sweepReport}>
            {{
              totalSweeps: survey.total,
              fixed: results.reduce((sum, result) => sum + result.fixed, 0),
              skipped: results.reduce((sum, result) => sum + result.skipped, 0),
              summary: `Audit sweeps: ${results.reduce((sum, result) => sum + result.fixed, 0)} issue(s) fixed.`,
            }}
          </Task>
        ) : null}

        {report ? (
          <Task id="sweep:output" output={outputs.output}>
            {{
              phase: "sweeps",
              status: report.skipped > 0 ? "partial" : "completed",
              summary: report.summary,
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
