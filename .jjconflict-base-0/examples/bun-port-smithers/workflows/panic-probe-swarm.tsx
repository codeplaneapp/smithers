/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import type { z } from "zod";

import { agentsForRepo } from "../components/agents";
import { DEFAULT_PROBES, dedupeFailures, stableNodeId } from "../components/porting-rules";
import { standardScorers } from "../components/scorers";
import {
  buildResultSchema,
  failureFixSchema,
  failureSetSchema,
  phaseDoneSchema,
  probeInputSchema,
  probeReportSchema,
  probeResultSchema,
} from "../components/schemas";
import BuildPrompt from "../prompts/build.mdx";
import FailureFixPrompt from "../prompts/failure-fix.mdx";
import ProbePrompt from "../prompts/probe.mdx";

const { Workflow, Task, Sequence, Parallel, Loop, smithers, outputs } = createSmithers(
  {
    input: probeInputSchema,
    buildResult: buildResultSchema,
    probeResult: probeResultSchema,
    failureSet: failureSetSchema,
    failureFix: failureFixSchema,
    probeReport: probeReportSchema,
    output: phaseDoneSchema,
  },
  { dbPath: process.env.BUN_PORT_SMITHERS_DB ?? "examples/bun-port-smithers/.tmp/smithers.db" },
);

const probeMemory = { kind: "workflow", id: "bun-port-probes" } as const;

export default smithers((ctx) => {
  const inputProbes = ctx.input.probes ?? [];
  const probes = inputProbes.length > 0 ? inputProbes : DEFAULT_PROBES;
  type BuildResult = z.infer<typeof buildResultSchema>;
  type ProbeResult = z.infer<typeof probeResultSchema>;
  type FailureSet = z.infer<typeof failureSetSchema>;
  type FailureFix = z.infer<typeof failureFixSchema>;
  type ProbeReport = z.infer<typeof probeReportSchema>;
  const agents = agentsForRepo(ctx.input.repo);
  const scorers = standardScorers(ctx.input.repo, 20 * 60_000);
  const build = ctx.latest("buildResult", "probe:build") as BuildResult | undefined;
  const results = probes
    .map((probe) => ctx.latest("probeResult", `probe:run:${stableNodeId(probe.id)}`) as ProbeResult | undefined)
    .filter((row): row is ProbeResult => Boolean(row));
  const failures = ctx.latest("failureSet", "probe:dedupe") as FailureSet | undefined;
  const fixes = failures
    ? failures.failures
      .map((failure) => ctx.latest("failureFix", `probe:fix:${stableNodeId(failure.failureKey)}`) as FailureFix | undefined)
      .filter((row): row is FailureFix => Boolean(row))
    : [];
  const allProbed = results.length >= probes.length;
  const allFixed = failures ? fixes.length >= failures.totalFailures : false;
  const report = ctx.latest("probeReport", "probe:report") as ProbeReport | undefined;

  return (
    <Workflow name="bun-port-panic-probe-swarm">
      <Sequence>
        <Loop
          id="probe:loop"
          until={report?.passed === probes.length}
          maxIterations={ctx.input.maxRounds ?? 5}
          onMaxReached="return-last"
        >
          <Sequence>
            <Task
              id="probe:build"
              output={outputs.buildResult}
              agent={agents.builder}
              timeoutMs={30 * 60_000}
              scorers={scorers}
              memory={{ remember: { namespace: probeMemory, key: "build" } }}
            >
              <BuildPrompt repo={ctx.input.repo} schema={buildResultSchema} />
            </Task>

          {build?.ok ? (
            <Parallel maxConcurrency={Math.max(1, probes.length)}>
              {probes.map((probe) => (
                <Task
                  key={probe.id}
                  id={`probe:run:${stableNodeId(probe.id)}`}
                  output={outputs.probeResult}
                  agent={agents.prober}
                  timeoutMs={10 * 60_000}
                  scorers={scorers}
                  memory={{ remember: { namespace: probeMemory, key: `probe:${probe.id}` } }}
                >
                  <ProbePrompt repo={ctx.input.repo} probe={probe} schema={probeResultSchema} />
                </Task>
              ))}
            </Parallel>
          ) : null}

          {allProbed ? (
            <Task id="probe:dedupe" output={outputs.failureSet}>
              {() => {
                const unique = dedupeFailures(results).map((failure) => ({
                  failureKey: failure.failureKey,
                  probeId: failure.probeId,
                  command: failure.command,
                  panicLocation: failure.panicLocation,
                  assertion: failure.assertion,
                }));
                return { totalFailures: unique.length, failures: unique };
              }}
            </Task>
          ) : null}

          {failures ? (
            <Parallel maxConcurrency={Math.max(1, failures.totalFailures)}>
              {failures.failures.map((failure) => (
                <Task
                  key={failure.failureKey}
                  id={`probe:fix:${stableNodeId(failure.failureKey)}`}
                  output={outputs.failureFix}
                  agent={agents.failureFixer}
                  skipIf={failures.totalFailures === 0}
                  timeoutMs={20 * 60_000}
                  scorers={scorers}
                  memory={{
                    recall: { namespace: probeMemory, query: failure.failureKey, topK: 5 },
                    remember: { namespace: probeMemory, key: `fix:${failure.failureKey}` },
                  }}
                >
                  <FailureFixPrompt repo={ctx.input.repo} failure={failure} schema={failureFixSchema} />
                </Task>
              ))}
            </Parallel>
          ) : null}

          {failures && allFixed ? (
            <Task id="probe:report" output={outputs.probeReport}>
              {{
                totalProbes: probes.length,
                passed: results.filter((result) => result.passed).length,
                uniqueFailures: failures.totalFailures,
                fixes: fixes.filter((fix) => fix.status === "fixed").length,
                summary: `Probe swarm: ${results.filter((result) => result.passed).length}/${probes.length} probe(s) passed.`,
              }}
            </Task>
          ) : null}

          </Sequence>
        </Loop>

        {report ? (
          <Task id="probe:output" output={outputs.output}>
            {{
              phase: "probes",
              status: report.passed === probes.length ? "completed" : "partial",
              summary: report.summary,
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
