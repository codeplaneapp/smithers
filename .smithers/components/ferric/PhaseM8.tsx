/** @jsxImportSource smthrs */
import { ContinueAsNew, Parallel, Sequence } from "smthrs";
import { Task, outputs } from "./ferricSmithers";
import { CampaignGate, gateRow } from "./CampaignGate";
import { FuzzTask } from "./FuzzTask";
import { PublishPipeline } from "./PublishPipeline";
import { Closeout } from "./Closeout";
import { SuiteTask } from "./SuiteTask";
import { sol } from "./ferricAgents";
import type { FerricConfig } from "./ferricConfig";
import { assertNotInfra, sh } from "./ferricShell";
import M8SemanticsAuditPrompt from "../../prompts/ferric-m8-semantics-audit.mdx";

/** M8 — harden, benchmark, and propose a release candidate. */
export function PhaseM8({ ctx, c }: { ctx: any; c: FerricConfig }) {
  const suite = ctx.outputMaybe(outputs.frcSuite, { nodeId: "m8:suite-final" });
  const rc = gateRow(ctx, "gate-rc");

  return (
    <Sequence label="M8 — harden + bench + RC">
      <Task id="m8:semantics-audit" output={outputs.frcPlan} agent={sol} timeoutMs={7_200_000}>
        <M8SemanticsAuditPrompt repo={c.repo} />
      </Task>

      <Parallel label="M8 evidence">
        <FuzzTask id="m8:fuzz" mode="differential" cases={100_000_000} repo={c.repo} />
        <Task id="m8:leaks" output={outputs.frcBench} retries={2}>
          {async () => {
            const r = await sh(
              ["bash", "scripts/ferric/leaks.sh", "--cycles", "10000", "--ssr-requests", "10000"],
              c.repo,
            );
            assertNotInfra(r, "leaks");
            return { bench: "leak-slopes", ratioX1000: r.ok ? 1000 : -1, withinContract: r.ok };
          }}
        </Task>
        <SuiteTask
          id="m8:suite-final"
          leg="all four --build cells DEV+prod + internal source leg"
          args={["--all"]}
          repo={c.repo}
        />
      </Parallel>

      {suite ? (
        <Sequence>
          <CampaignGate
            id="gate-rc"
            summary={`RC gate. Suite: ${suite.passingCount}/${suite.totalCount}, green=${suite.green}, xfail bucket (c)=${suite.xfailBucketC} — that bucket must be 0; the declared fallback of up to 10 with public issues requires a narrower public claim. Fuzz, leak, and bench rows are in frcFuzz and frcBench, judged against the BENCH_CONTRACT.md frozen at M0. Zero tests skipped, deleted, or edited; the backend assertion was on for every leg.`}
          />
          {rc?.approved ? (
            <Sequence>
              <PublishPipeline
                ctx={ctx}
                c={c}
                artifact="@ferric RC (npm, rc dist-tag)"
                idPrefix="m8:publish-rc"
                gateId="gate-publish-rc"
                instructions="Release-candidate publish of the @ferric packages under the rc dist-tag, with the signed compatibility manifest and the courtesy-note draft to the React team. This is an RC, not GA: the claim must say so."
              />
              <ContinueAsNew
                state={{ milestone: "GA", spentCents: c.spentCents, lineage: [...c.lineage, ctx.runId] }}
              />
            </Sequence>
          ) : rc?.approved === false ? (
            <Closeout
              ctx={ctx}
              c={c}
              reason="RC gate denied: the release-candidate evidence did not satisfy the operator."
            />
          ) : null}
        </Sequence>
      ) : null}
    </Sequence>
  );
}
