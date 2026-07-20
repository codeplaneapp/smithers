/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import type { z } from "zod";

import { agentsForRepo } from "../components/agents";
import { groupCratesByTier, stableNodeId } from "../components/porting-rules";
import { standardScorers } from "../components/scorers";
import {
  compileReportSchema,
  crateCheckSchema,
  crateCompileInputSchema,
  cratePlanSchema,
  phaseDoneSchema,
} from "../components/schemas";
import CrateCheckPrompt from "../prompts/crate-check.mdx";

const { Workflow, Task, Sequence, Parallel, Loop, smithers, outputs } = createSmithers(
  {
    input: crateCompileInputSchema,
    cratePlan: cratePlanSchema,
    crateCheck: crateCheckSchema,
    compileReport: compileReportSchema,
    output: phaseDoneSchema,
  },
  { dbPath: process.env.BUN_PORT_SMITHERS_DB ?? "examples/bun-port-smithers/.tmp/smithers.db" },
);

const compileMemory = { kind: "workflow", id: "bun-port-compile" } as const;

export default smithers((ctx) => {
  type CratePlan = z.infer<typeof cratePlanSchema>;
  type CrateCheck = z.infer<typeof crateCheckSchema>;
  type CompileReport = z.infer<typeof compileReportSchema>;
  const agents = agentsForRepo(ctx.input.repo);
  const scorers = standardScorers(ctx.input.repo, 20 * 60_000);
  const plan = ctx.outputMaybe(outputs.cratePlan, { nodeId: "compile:plan" }) as CratePlan | undefined;
  const crates = plan?.tiers.flatMap((tier) => tier.crates) ?? [];
  const latestChecks = crates
    .map((crate) => ctx.latest("crateCheck", `compile:${stableNodeId(crate.name)}:check`) as CrateCheck | undefined)
    .filter((check): check is CrateCheck => Boolean(check));
  const totalCrates = plan?.totalCrates ?? 0;
  const hasAllChecks = plan ? latestChecks.length >= totalCrates : false;
  const report = ctx.outputMaybe(outputs.compileReport, { nodeId: "compile:report" }) as CompileReport | undefined;

  return (
    <Workflow name="bun-port-crate-compile-bringup">
      <Sequence>
        <Task id="compile:plan" output={outputs.cratePlan}>
          {() => {
            const tiers = groupCratesByTier(ctx.input.crates ?? []).map((crates) => ({
              tier: crates[0]?.tier ?? 0,
              crates,
            }));
            return { tiers, totalCrates: tiers.reduce((sum, tier) => sum + tier.crates.length, 0) };
          }}
        </Task>

        {plan?.tiers.map((tier) => (
          <Sequence key={`tier-${tier.tier}`}>
            <Parallel maxConcurrency={Math.max(1, tier.crates.length)}>
              {tier.crates.map((crate) => {
                const crateId = stableNodeId(crate.name);
                const latest = ctx.latest("crateCheck", `compile:${crateId}:check`) as CrateCheck | undefined;
                return (
                  <Loop
                    key={crate.name}
                    id={`compile:${crateId}:loop`}
                    until={latest?.compiles === true}
                    maxIterations={ctx.input.maxRounds ?? 25}
                    onMaxReached="return-last"
                  >
                    <Task
                      id={`compile:${crateId}:check`}
                      output={outputs.crateCheck}
                      agent={agents.crateChecker}
                      timeoutMs={20 * 60_000}
                      scorers={scorers}
                      memory={{
                        recall: { namespace: compileMemory, query: crate.name, topK: 8 },
                        remember: { namespace: compileMemory, key: `crate:${crate.name}` },
                      }}
                    >
                      <CrateCheckPrompt
                        repo={ctx.input.repo}
                        crate={crate}
                        previous={latest ?? null}
                        schema={crateCheckSchema}
                      />
                    </Task>
                  </Loop>
                );
              })}
            </Parallel>
          </Sequence>
        ))}

        {hasAllChecks ? (
          <Task id="compile:report" output={outputs.compileReport}>
            {() => {
              const greenCrates = latestChecks.filter((check) => check.compiles).map((check) => check.crate);
              const failingCrates = latestChecks.filter((check) => !check.compiles).map((check) => check.crate);
              const gatedModules = latestChecks.reduce((sum, check) => sum + check.gatedModules.length, 0);
              return {
                totalCrates,
                green: greenCrates.length,
                failing: failingCrates.length,
                gatedModules,
                greenCrates,
                failingCrates,
                summary: `Compile bring-up: ${greenCrates.length}/${totalCrates} crate(s) green; ${gatedModules} gated module(s).`,
              };
            }}
          </Task>
        ) : null}

        {report ? (
          <Task id="compile:output" output={outputs.output}>
            {{
              phase: "compile",
              status: report.failing > 0 ? "partial" : "completed",
              summary: report.summary,
              gatedModules: report.gatedModules,
              failingCrates: report.failingCrates,
              greenCrates: report.greenCrates,
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
