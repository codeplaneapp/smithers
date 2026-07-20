/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import type { z } from "zod";

import { agentsForRepo } from "../components/agents";
import { normalizePortFiles, stableNodeId } from "../components/porting-rules";
import { standardScorers } from "../components/scorers";
import {
  phaseAFixSchema,
  phaseAImplementSchema,
  phaseAInputSchema,
  phaseAPlanSchema,
  phaseAReportSchema,
  phaseDoneSchema,
  reviewSchema,
} from "../components/schemas";
import PhaseAFixPrompt from "../prompts/phase-a-fix.mdx";
import PhaseAImplementPrompt from "../prompts/phase-a-implement.mdx";
import PhaseAVerifyPrompt from "../prompts/phase-a-verify.mdx";

const { Workflow, Task, Sequence, Parallel, smithers, outputs } = createSmithers(
  {
    input: phaseAInputSchema,
    phaseAPlan: phaseAPlanSchema,
    phaseAImplement: phaseAImplementSchema,
    phaseAReview: reviewSchema,
    phaseAFix: phaseAFixSchema,
    phaseAReport: phaseAReportSchema,
    output: phaseDoneSchema,
  },
  { dbPath: process.env.BUN_PORT_SMITHERS_DB ?? "examples/bun-port-smithers/.tmp/smithers.db" },
);

const phaseAMemory = { kind: "workflow", id: "bun-port-phase-a" } as const;

export default smithers((ctx) => {
  type PhaseAPlan = z.infer<typeof phaseAPlanSchema>;
  type PhaseAImplement = z.infer<typeof phaseAImplementSchema>;
  type PhaseAReview = z.infer<typeof reviewSchema>;
  type PhaseAFix = z.infer<typeof phaseAFixSchema>;
  const agents = agentsForRepo(ctx.input.repo);
  const scorers = standardScorers(ctx.input.repo, 30 * 60_000);
  const plan = ctx.outputMaybe(outputs.phaseAPlan, { nodeId: "phase-a:plan" }) as PhaseAPlan | undefined;
  const report = ctx.outputMaybe(outputs.phaseAReport, { nodeId: "phase-a:report" }) as z.infer<typeof phaseAReportSchema> | undefined;
  const files = plan?.files ?? [];
  const rows = files.map((file) => {
    const fileId = stableNodeId(file.zig);
    return {
      file,
      implementation: ctx.outputMaybe(outputs.phaseAImplement, { nodeId: `phase-a:${fileId}:implement` }) as PhaseAImplement | undefined,
      review: ctx.outputMaybe(outputs.phaseAReview, { nodeId: `phase-a:${fileId}:verify` }) as PhaseAReview | undefined,
      fix: ctx.outputMaybe(outputs.phaseAFix, { nodeId: `phase-a:${fileId}:fix` }) as PhaseAFix | undefined,
    };
  });
  const allReviewed = plan ? rows.every((row) => Boolean(row.review)) : false;
  const allFixedOrClean = plan
    ? rows.every((row) => row.review?.approved === true || row.review?.ok === true || Boolean(row.fix))
    : false;

  return (
    <Workflow name="bun-port-phase-a">
      <Sequence>
        <Task id="phase-a:plan" output={outputs.phaseAPlan}>
          {() => {
            const normalized = normalizePortFiles(ctx.input.files ?? []);
            return { total: normalized.length, files: normalized };
          }}
        </Task>

        {plan ? (
          <Parallel maxConcurrency={ctx.input.maxConcurrency ?? 8}>
            {files.map((file) => {
              const fileId = stableNodeId(file.zig);
              const review = ctx.outputMaybe(outputs.phaseAReview, { nodeId: `phase-a:${fileId}:verify` }) as PhaseAReview | undefined;
              const mustFix = (review?.issues ?? []).some((issue) => issue.severity !== "nit");
              return (
                <Sequence key={file.zig}>
                  <Task
                    id={`phase-a:${fileId}:implement`}
                    output={outputs.phaseAImplement}
                    agent={agents.phaseAImplementer}
                    timeoutMs={30 * 60_000}
                    retries={1}
                    scorers={scorers}
                    memory={{
                      recall: { namespace: phaseAMemory, query: `${file.zig} ${file.crate}`, topK: 8 },
                      remember: { namespace: phaseAMemory, key: `implement:${file.zig}` },
                    }}
                  >
                    <PhaseAImplementPrompt
                      repo={ctx.input.repo}
                      file={file}
                      feedback={null}
                      schema={phaseAImplementSchema}
                    />
                  </Task>

                  <Task
                    id={`phase-a:${fileId}:verify`}
                    output={outputs.phaseAReview}
                    agent={agents.phaseAVerifier}
                    timeoutMs={15 * 60_000}
                    scorers={scorers}
                    memory={{ remember: { namespace: phaseAMemory, key: `verify:${file.zig}` } }}
                  >
                    <PhaseAVerifyPrompt repo={ctx.input.repo} file={file} schema={reviewSchema} />
                  </Task>

                  {mustFix ? (
                    <Task
                      id={`phase-a:${fileId}:fix`}
                      output={outputs.phaseAFix}
                      agent={agents.phaseAFixer}
                      timeoutMs={15 * 60_000}
                      scorers={scorers}
                      memory={{ remember: { namespace: phaseAMemory, key: `fix:${file.zig}` } }}
                    >
                      <PhaseAFixPrompt
                        repo={ctx.input.repo}
                        file={file}
                        issues={review?.issues ?? []}
                        schema={phaseAFixSchema}
                      />
                    </Task>
                  ) : null}
                </Sequence>
              );
            })}
          </Parallel>
        ) : null}

        {plan && allReviewed && allFixedOrClean ? (
          <Task id="phase-a:report" output={outputs.phaseAReport}>
            {() => {
              const implementations = rows.map((row) => row.implementation).filter((row): row is PhaseAImplement => Boolean(row));
              const reviews = rows.map((row) => row.review).filter((row): row is PhaseAReview => Boolean(row));
              const fixes = rows.map((row) => row.fix).filter((row): row is PhaseAFix => Boolean(row));
              return {
                total: plan.total,
                clean: reviews.filter((review) => review.approved || review.ok).length,
                fixed: fixes.filter((fix) => fix.remaining === 0).length,
                failed: implementations.filter((impl) => impl.status === "failed").length,
                todoCount: implementations.reduce((sum, impl) => sum + impl.todos, 0),
                summary: `Phase A: ${reviews.filter((review) => review.approved || review.ok).length}/${plan.total} clean, ${fixes.length} fix task(s).`,
              };
            }}
          </Task>
        ) : null}

        {report ? (
          <Task id="phase-a:output" output={outputs.output}>
            {{
              phase: "phaseA",
              status: report.failed > 0 ? "partial" : "completed",
              summary: report.summary,
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
