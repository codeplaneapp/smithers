/** @jsxImportSource smthrs */
import { ContinueAsNew, Loop, Sequence } from "smthrs";
import { Task, outputs } from "./ferricSmithers";
import { CampaignGate, gateRow } from "./CampaignGate";
import { Closeout } from "./Closeout";
import { sol, terra } from "./ferricAgents";
import { MODEL_CAP_CENTS, PRE_M8_STOP_CENTS, type FerricConfig } from "./ferricConfig";
import M3SpikePrompt from "../../prompts/ferric-m3-spike.mdx";

/**
 * M3 — the throwaway boundary spike, and the first kill gate.
 *
 * This is where the campaign finds out whether a Rust engine can beat the
 * JavaScript one it replaces once the boundary tax is paid. A human decides on
 * the measurement; denial routes to a signed public closeout.
 */
export function PhaseM3({ ctx, c }: { ctx: any; c: FerricConfig }) {
  const spike = ctx.latest(outputs.frcPoc, "m3:spike");
  const spikeRounds = ctx.iterationCount(outputs.frcPoc, "m3:spike");
  const kill = gateRow(ctx, "gate-m3-kill");
  const spend = gateRow(ctx, "gate-spend-m3");
  const decided = spike && (spike.withinKillGate === true || spikeRounds >= 2);

  return (
    <Sequence label="M3 — boundary spike (throwaway) + kill gate">
      <Loop id="m3:spike-loop" until={spike?.withinKillGate === true} maxIterations={2} onMaxReached="return-last">
        <Task id="m3:spike" output={outputs.frcPoc} agent={[...sol, ...terra]} timeoutMs={14_400_000}>
          <M3SpikePrompt repo={c.repo} reactRepo={c.reactRepo} revision={spikeRounds + 1} />
        </Task>
      </Loop>

      {decided ? (
        <Sequence>
          <CampaignGate
            id="gate-spend-m3"
            summary={`Spend gate at M3: attested $${(c.spentCents / 100).toFixed(0)} of the $${(MODEL_CAP_CENTS / 100).toFixed(0)} cap, with a $${(PRE_M8_STOP_CENTS / 100).toFixed(0)} stop-line before M8 is green. Deny to stop and rescope.`}
          />
          <CampaignGate
            id="gate-m3-kill"
            summary={`KILL GATE #1 — boundary economics. The spike measured ${(spike.ratioX1000 / 1000).toFixed(2)}x upstream after ${spike.protocolRevisions} protocol revision(s); ABI choice: ${spike.abiChoice}; withinKillGate=${spike.withinKillGate}. The line is at most 1.5x within at most 2 revisions. APPROVE proceeds to M4. DENY kills the browser runtime and publishes a signed public closeout — the honest failure is still the durability demonstration.`}
          />
          {kill != null ? (
            kill.approved && spend?.approved ? (
              <ContinueAsNew
                state={{ milestone: "M4", spentCents: c.spentCents, lineage: [...c.lineage, ctx.runId] }}
              />
            ) : kill.approved === false ? (
              <Closeout
                ctx={ctx}
                c={c}
                reason="M3 kill gate: the boundary economics missed the 1.5x line after the allowed protocol revisions."
              />
            ) : null
          ) : null}
        </Sequence>
      ) : null}
    </Sequence>
  );
}
