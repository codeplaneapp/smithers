/** @jsxImportSource smthrs */
import { ContinueAsNew, Sequence } from "smthrs";
import { Task, outputs } from "./ferricSmithers";
import { CampaignGate, gateRow } from "./CampaignGate";
import { Closeout } from "./Closeout";
import { planner } from "./ferricAgents";
import { MODEL_CAP_CENTS, PRE_M8_STOP_CENTS, type FerricConfig, type SliceDef } from "./ferricConfig";
import { frontier } from "./ferricLedger";
import { PortCampaign } from "./PortCampaign";
import { QueueParse } from "./QueueParse";
import M4DriftAlertPrompt from "../../prompts/ferric-m4-drift-alert.mdx";

/**
 * M4 — the reconciler, ported through the noop oracle.
 *
 * The bulk of the campaign: 22 leaf modules plus six cohorts over the reconciler's
 * import cycle, judged by 76 files and 1,039 cases. Ends at the week-6 go/no-go.
 */
export function PhaseM4({ ctx, c }: { ctx: any; c: FerricConfig }) {
  const queue = ctx.outputMaybe(outputs.frcQueue, { nodeId: "queue-parse" });
  const slices: SliceDef[] = queue ? JSON.parse(queue.slices) : [];
  const f = frontier(ctx, c.repo, slices, outputs);
  const half = f.total > 0 && f.landed.length >= Math.ceil(f.total / 2);
  const spendM4 = gateRow(ctx, "gate-spend-m4");
  const gonogo = gateRow(ctx, "gate-wk6");
  const gateReady = f.total > 0 && (f.done || f.blocked.length > 0);

  // Deterministic drift check from the durable ledger. The shipped DriftDetector
  // is single-shot and agent-driven, which is the wrong tool for a frontier that
  // moves on every landing.
  const offTrack = f.total > 0 && f.blocked.length >= 2;

  return (
    <Sequence label="M4 — reconciler via noop oracle">
      <QueueParse c={c} />
      {slices.length > 0 ? <PortCampaign ctx={ctx} c={c} phase="M4" slices={slices} /> : null}

      {offTrack ? (
        <Task id="m4:drift-alert" output={outputs.frcDriftAlert} agent={planner} continueOnFail timeoutMs={1_800_000}>
          <M4DriftAlertPrompt
            landed={f.landed.length}
            total={f.total}
            blockedCount={f.blocked.length}
            blockedIds={f.blocked.map((b) => b.id).join(", ")}
          />
        </Task>
      ) : null}

      {half && !spendM4 ? (
        <CampaignGate
          id="gate-spend-m4"
          summary={`Half of the M4 queue has landed (${f.landed.length}/${f.total}). Attested spend $${(c.spentCents / 100).toFixed(0)} against the $${(MODEL_CAP_CENTS / 100).toFixed(0)} cap and the $${(PRE_M8_STOP_CENTS / 100).toFixed(0)} pre-M8 stop-line.`}
        />
      ) : null}

      {gateReady ? (
        <Sequence>
          <CampaignGate
            id="gate-wk6"
            summary={`M4 week-6 go/no-go. ${f.landed.length}/${f.total} slices landed; ratchet ${f.ledger.passingCount}/${f.ledger.totalCount}. Blocked lanes: ${f.blocked.map((b) => b.id).join(", ") || "none"}. The gate needs at least 832 of 1,039 noop-oracle cases green with no denominator reduction. APPROVE proceeds to M5/M6. DENY publishes a signed closeout.`}
          />
          {gonogo != null ? (
            gonogo.approved ? (
              <ContinueAsNew
                state={{ milestone: "M5M6", spentCents: c.spentCents, lineage: [...c.lineage, ctx.runId] }}
              />
            ) : (
              <Closeout
                ctx={ctx}
                c={c}
                reason="M4 week-6 go/no-go: fewer than 80% of the 1,039 reconciler cases were green at the deadline."
              />
            )
          ) : null}
        </Sequence>
      ) : null}
    </Sequence>
  );
}
