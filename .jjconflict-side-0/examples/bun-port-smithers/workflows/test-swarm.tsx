/** @jsxImportSource smithers-orchestrator */
import { resolve } from "node:path";
import { createSmithers } from "smithers-orchestrator";
import type { z } from "zod";

import { agentsForRepo } from "../components/agents";
import { DEFAULT_TEST_AREAS, stableNodeId } from "../components/porting-rules";
import { standardScorers } from "../components/scorers";
import {
  ciSignalSchema,
  mergeResultSchema,
  phaseDoneSchema,
  testAreaResultSchema,
  testSwarmInputSchema,
  testSwarmReportSchema,
} from "../components/schemas";
import MergePrompt from "../prompts/merge.mdx";
import TestAreaPrompt from "../prompts/test-area.mdx";

const { Workflow, Task, Sequence, Parallel, Loop, MergeQueue, Worktree, Signal, smithers, outputs } = createSmithers(
  {
    input: testSwarmInputSchema,
    testAreaResult: testAreaResultSchema,
    mergeResult: mergeResultSchema,
    testSwarmReport: testSwarmReportSchema,
    ciSignal: ciSignalSchema,
    output: phaseDoneSchema,
  },
  { dbPath: process.env.BUN_PORT_SMITHERS_DB ?? "examples/bun-port-smithers/.tmp/smithers.db" },
);

const testMemory = { kind: "workflow", id: "bun-port-test-swarm" } as const;

export default smithers((ctx) => {
  const inputAreas = ctx.input.areas ?? [];
  const areas = inputAreas.length > 0 ? inputAreas : DEFAULT_TEST_AREAS;
  type TestAreaResult = z.infer<typeof testAreaResultSchema>;
  type MergeResult = z.infer<typeof mergeResultSchema>;
  const agents = agentsForRepo(ctx.input.repo);
  const scorers = standardScorers(ctx.input.repo, 30 * 60_000);
  const results = areas
    .map((area) => ctx.latest("testAreaResult", `test-swarm:${stableNodeId(area.id)}:area`) as TestAreaResult | undefined)
    .filter((result): result is TestAreaResult => Boolean(result));
  const resultByArea = new Map(results.map((result) => [result.areaId, result]));
  const mergeableAreas = areas.filter((area) => {
    const result = resultByArea.get(area.id);
    if (!result) return false;
    return ctx.input.requireGreenBeforeMerge === false || result.allPass === true;
  });
  const merges = mergeableAreas
    .map((area) => ctx.outputMaybe(outputs.mergeResult, { nodeId: `test-swarm:${stableNodeId(area.id)}:merge` }) as MergeResult | undefined)
    .filter((merge): merge is MergeResult => Boolean(merge));
  const ciSignal = ctx.outputMaybe(outputs.ciSignal, { nodeId: "test-swarm:external-ci" });
  const report = ctx.outputMaybe(outputs.testSwarmReport, { nodeId: "test-swarm:report" }) as z.infer<typeof testSwarmReportSchema> | undefined;
  const allAreasHaveResult = results.length >= areas.length;
  const ciSatisfied = !ctx.input.awaitExternalCiSignal || ciSignal?.status === "passed";
  const readyToMerge = allAreasHaveResult && ciSatisfied;
  const allMergesDone = readyToMerge && merges.length >= mergeableAreas.length;

  return (
    <Workflow name="bun-port-test-swarm">
      <Sequence>
        <Parallel maxConcurrency={ctx.input.maxConcurrency ?? 8}>
          {areas.map((area) => {
            const areaNodeId = stableNodeId(area.id);
            const latest = ctx.latest("testAreaResult", `test-swarm:${areaNodeId}:area`) as TestAreaResult | undefined;
            const branch = `bun-port/${area.id}`;
            const areaLoop = (
              <Loop
                key={area.id}
                id={`test-swarm:${areaNodeId}:loop`}
                until={latest?.allPass === true}
                maxIterations={ctx.input.maxIterations ?? 30}
                onMaxReached="return-last"
              >
                <Task
                  id={`test-swarm:${areaNodeId}:area`}
                  output={outputs.testAreaResult}
                  agent={agents.testAreaWorker}
                  timeoutMs={30 * 60_000}
                  scorers={scorers}
                  memory={{
                    recall: { namespace: testMemory, query: `${area.id} ${area.glob}`, topK: 8 },
                    remember: { namespace: testMemory, key: `area:${area.id}` },
                  }}
                >
                  <TestAreaPrompt
                    repo={ctx.input.repo}
                    area={area}
                    branch={branch}
                    previous={latest ?? null}
                    schema={testAreaResultSchema}
                  />
                </Task>
              </Loop>
            );
            return ctx.input.useWorktrees === false ? areaLoop : (
              <Worktree
                key={area.id}
                path={resolve(ctx.input.repo, ".worktrees", `bun-port-${area.id}`)}
                branch={branch}
                baseBranch={ctx.input.baseBranch ?? "main"}
              >
                {areaLoop}
              </Worktree>
            );
          })}
        </Parallel>

        {allAreasHaveResult && ctx.input.awaitExternalCiSignal ? (
          <Signal
            id="test-swarm:external-ci"
            schema={outputs.ciSignal}
            correlationId={ctx.input.ciCorrelationId}
            timeoutMs={24 * 60 * 60_000}
            onTimeout="fail"
          />
        ) : null}

        {readyToMerge ? (
          <MergeQueue id="test-swarm:merge-queue" maxConcurrency={1}>
            {mergeableAreas.map((area) => {
              const result = resultByArea.get(area.id);
              const branch = `bun-port/${area.id}`;
              return (
                <Task
                  key={area.id}
                  id={`test-swarm:${stableNodeId(area.id)}:merge`}
                  output={outputs.mergeResult}
                  agent={agents.mergeAgent}
                  timeoutMs={15 * 60_000}
                  scorers={scorers}
                  memory={{ remember: { namespace: testMemory, key: `merge:${area.id}` } }}
                >
                  <MergePrompt
                    repo={ctx.input.repo}
                    area={area}
                    branch={branch}
                    result={result ?? null}
                    schema={mergeResultSchema}
                  />
                </Task>
              );
            })}
          </MergeQueue>
        ) : null}

        {allMergesDone ? (
          <Task id="test-swarm:report" output={outputs.testSwarmReport}>
            {{
              areas: areas.length,
              allPass: results.filter((result) => result.allPass).length,
              partial: results.filter((result) => !result.allPass).length,
              merged: merges.reduce((sum, merge) => sum + merge.picked, 0),
              summary: `Test swarm: ${results.filter((result) => result.allPass).length}/${areas.length} area(s) all-pass; ${mergeableAreas.length} area branch(es) eligible for merge.`,
            }}
          </Task>
        ) : null}

        {report ? (
          <Task id="test-swarm:output" output={outputs.output}>
            {{
              phase: "tests",
              status: report.partial > 0 ? "partial" : "completed",
              summary: report.summary,
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
