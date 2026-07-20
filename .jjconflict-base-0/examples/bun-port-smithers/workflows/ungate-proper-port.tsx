/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import type { z } from "zod";

import { agentsForRepo } from "../components/agents";
import { stableNodeId } from "../components/porting-rules";
import { standardScorers } from "../components/scorers";
import {
  patchResultSchema,
  phaseDoneSchema,
  specDecisionSchema,
  specReviewSchema,
  targetSurveySchema,
  ungateInputSchema,
  ungateReportSchema,
} from "../components/schemas";
import ProperPortPrompt from "../prompts/proper-port.mdx";
import SpecDecisionPrompt from "../prompts/spec-decision.mdx";
import SpecReviewPrompt from "../prompts/spec-review.mdx";

const { Workflow, Task, Sequence, Parallel, Loop, smithers, outputs } = createSmithers(
  {
    input: ungateInputSchema,
    targetSurvey: targetSurveySchema,
    patchResult: patchResultSchema,
    specReview: specReviewSchema,
    specDecision: specDecisionSchema,
    ungateReport: ungateReportSchema,
    output: phaseDoneSchema,
  },
  { dbPath: process.env.BUN_PORT_SMITHERS_DB ?? "examples/bun-port-smithers/.tmp/smithers.db" },
);

const ungateMemory = { kind: "workflow", id: "bun-port-ungate" } as const;

export default smithers((ctx) => {
  type TargetSurvey = z.infer<typeof targetSurveySchema>;
  type PatchResult = z.infer<typeof patchResultSchema>;
  type SpecReview = z.infer<typeof specReviewSchema>;
  type SpecDecision = z.infer<typeof specDecisionSchema>;
  const agents = agentsForRepo(ctx.input.repo);
  const scorers = standardScorers(ctx.input.repo, 20 * 60_000);
  const survey = ctx.outputMaybe(outputs.targetSurvey, { nodeId: "ungate:survey" }) as TargetSurvey | undefined;
  const report = ctx.outputMaybe(outputs.ungateReport, { nodeId: "ungate:report" }) as z.infer<typeof ungateReportSchema> | undefined;
  const targets = survey?.targets ?? [];
  const latestFor = (targetId: string) => {
    const targetNodeId = stableNodeId(targetId);
    const patch = ctx.latest("patchResult", `ungate:${targetNodeId}:patch`) as PatchResult | undefined;
    const reviews = [0, 1]
      .map((index) => ctx.latest("specReview", `ungate:${targetNodeId}:review:${index}`) as SpecReview | undefined)
      .filter((review): review is SpecReview => Boolean(review));
    const decision = ctx.latest("specDecision", `ungate:${targetNodeId}:decision`) as SpecDecision | undefined;
    return { patch, reviews, decision };
  };
  const rows = targets.map((target) => ({ target, ...latestFor(target.id) }));
  const allDecided = survey ? rows.every((row) => Boolean(row.decision)) : false;

  return (
    <Workflow name="bun-port-ungate-proper-port">
      <Sequence>
        <Task id="ungate:survey" output={outputs.targetSurvey}>
          {{
            totalTargets: (ctx.input.targets ?? []).length,
            targets: (ctx.input.targets ?? []).map((target) => ({
              ...target,
              reason: target.reason ?? "ungate/proper-port",
            })),
          }}
        </Task>

        {survey ? (
          <Parallel maxConcurrency={Math.max(1, targets.length)}>
            {targets.map((target) => {
              const targetNodeId = stableNodeId(target.id);
              const { patch, reviews, decision } = latestFor(target.id);
              return (
                <Loop
                  key={target.id}
                  id={`ungate:${targetNodeId}:loop`}
                  until={decision?.approved === true}
                  maxIterations={ctx.input.maxRounds ?? 5}
                  onMaxReached="return-last"
                >
                  <Sequence>
                    <Task
                      id={`ungate:${targetNodeId}:patch`}
                      output={outputs.patchResult}
                      agent={agents.properPorter}
                      timeoutMs={30 * 60_000}
                      scorers={scorers}
                      memory={{
                        recall: { namespace: ungateMemory, query: `${target.id} ${target.file}`, topK: 8 },
                        remember: { namespace: ungateMemory, key: `patch:${target.id}` },
                      }}
                    >
                      <ProperPortPrompt
                        repo={ctx.input.repo}
                        target={target}
                        previousDecision={decision ?? null}
                        schema={patchResultSchema}
                      />
                    </Task>

                    <Parallel maxConcurrency={2}>
                      {[0, 1].map((index) => (
                        <Task
                          key={String(index)}
                          id={`ungate:${targetNodeId}:review:${index}`}
                          output={outputs.specReview}
                          agent={agents.specReviewer}
                          timeoutMs={15 * 60_000}
                          scorers={scorers}
                          memory={{ remember: { namespace: ungateMemory, key: `review:${target.id}:${index}` } }}
                        >
                          <SpecReviewPrompt
                            repo={ctx.input.repo}
                            target={target}
                            voter={`spec-reviewer-${index + 1}`}
                            patch={patch ?? null}
                            schema={specReviewSchema}
                          />
                        </Task>
                      ))}
                    </Parallel>

                    {reviews.length >= 2 ? (
                      <Task
                        id={`ungate:${targetNodeId}:decision`}
                        output={outputs.specDecision}
                        agent={agents.specDecider}
                        timeoutMs={10 * 60_000}
                        scorers={scorers}
                        memory={{ remember: { namespace: ungateMemory, key: `decision:${target.id}` } }}
                      >
                        <SpecDecisionPrompt
                          repo={ctx.input.repo}
                          target={target}
                          reviews={reviews}
                          schema={specDecisionSchema}
                        />
                      </Task>
                    ) : null}
                  </Sequence>
                </Loop>
              );
            })}
          </Parallel>
        ) : null}

        {survey && allDecided ? (
          <Task id="ungate:report" output={outputs.ungateReport}>
            {() => {
              const approved = rows.filter((row) => row.decision?.approved).length;
              const patched = rows.filter((row) => row.patch?.status === "patched").length;
              return {
                totalTargets: survey.totalTargets,
                patched,
                approved,
                rejected: survey.totalTargets - approved,
                summary: `Ungate/proper-port: ${approved}/${survey.totalTargets} target(s) approved.`,
              };
            }}
          </Task>
        ) : null}

        {report ? (
          <Task id="ungate:output" output={outputs.output}>
            {{
              phase: "ungate",
              status: report.rejected > 0 ? "partial" : "completed",
              summary: report.summary,
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
