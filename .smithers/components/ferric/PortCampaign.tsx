/** @jsxImportSource smithers-orchestrator */
import { Parallel, Sequence } from "smithers-orchestrator";
import { Task, outputs } from "./ferricSmithers";
import { CampaignGate, gateRow } from "./CampaignGate";
import { Slice } from "./Slice";
import type { FerricConfig, SliceDef } from "./ferricConfig";
import { readLedger, writeLedger } from "./ferricLedger";

/**
 * Queue-backfill over a phase's slices.
 *
 * Leaves fan out across the lane budget; cohorts land STRICTLY one at a time and
 * only after every leaf has landed. That ordering is the D5 rule — never per-module
 * lanes over the reconciler's 59-module import cycle — and it is enforced by the
 * shape of this graph rather than by asking an agent to be careful.
 */
export function PortCampaign(props: {
  ctx: any;
  c: FerricConfig;
  phase: string;
  slices: SliceDef[];
}) {
  const { ctx, c, phase, slices } = props;
  const ledger = readLedger(c.repo);
  const budget = ctx.outputMaybe(outputs.frcBudget, { nodeId: "budget" });
  const admit = (budget?.admitNewWork ?? true) && !ledger.halted;

  const remaining = slices.filter((s) => !ledger.landed.includes(s.id));
  const leafs = remaining.filter((s) => s.kind !== "cohort");
  const cohorts = remaining.filter((s) => s.kind === "cohort");
  const cohortsReady = slices
    .filter((s) => s.kind !== "cohort")
    .every((s) => ledger.landed.includes(s.id));

  return (
    <Sequence label={`${phase} port campaign`}>
      {ledger.halted ? (
        // Keyed by halt epoch: each regression is its own decision. A static
        // id would let the first clearance permanently auto-pass every later halt.
        <CampaignGate
          id="gate-ratchet-halt"
          instance={`e${ledger.haltEpoch}`}
          summary={`The monotone ratchet went backwards on a landing in ${phase} (halt epoch ${ledger.haltEpoch}). The merge was reverted and the landing queue is durably halted. Evidence: frcLand rows with regression=true, and the ferric-ledger.json passing count. Approving increments the halt epoch and re-admits landing; denying stops the campaign here.`}
        />
      ) : null}

      {ledger.halted && gateRow(ctx, "gate-ratchet-halt", `e${ledger.haltEpoch}`)?.approved ? (
        <Task id={`${phase}:clear-halt:e${ledger.haltEpoch}`} output={outputs.frcFoundation}>
          {() => {
            const led = readLedger(c.repo);
            writeLedger(c.repo, { ...led, halted: false, haltEpoch: led.haltEpoch + 1 });
            return {
              launchRootOk: true,
              scriptsOk: true,
              queueOk: true,
              selfAuditOk: true,
              detail: `halt cleared, epoch ${led.haltEpoch + 1}`,
            };
          }}
        </Task>
      ) : null}

      {admit ? (
        <Sequence>
          <Parallel id={`${phase}:leaf-lanes`} subtreeConcurrency={c.maxLanes}>
            {leafs.slice(0, c.maxLanes * 2).map((s) => (
              <Slice key={s.id} ctx={ctx} c={c} slice={s} />
            ))}
          </Parallel>
          {cohortsReady
            ? cohorts.slice(0, 1).map((s) => <Slice key={s.id} ctx={ctx} c={c} slice={s} />)
            : null}
        </Sequence>
      ) : null}
    </Sequence>
  );
}
