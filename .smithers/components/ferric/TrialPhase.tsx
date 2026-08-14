/** @jsxImportSource smthrs */
import type { ReactNode } from "react";
import { ContinueAsNew, Sequence } from "smthrs";
import { outputs } from "./ferricSmithers";
import { CampaignGate, gateRow } from "./CampaignGate";
import { NEXT, type FerricConfig, type Milestone, type SliceDef } from "./ferricConfig";
import { frontier } from "./ferricLedger";
import { PortCampaign } from "./PortCampaign";
import { Closeout } from "./Closeout";
import type { FerricGateId } from "./ferricGates";

/**
 * The shared shape of a milestone that is "run the slice machine over a fixed
 * set, then gate": M1, M2, M5/M6, M7, and M9's implementation half.
 *
 * The gate mounts when the frontier is done OR has blocked lanes — never only on
 * all-green, so an exhausted lane surfaces as evidence at the gate instead of
 * crashing past it.
 */
export function TrialPhase(props: {
  ctx: any;
  c: FerricConfig;
  milestone: Milestone;
  slices: SliceDef[];
  gateId: FerricGateId;
  summary?: string;
  evidence?: ReactNode;
  extra?: ReactNode;
}) {
  const { ctx, c } = props;
  const f = frontier(ctx, c.repo, props.slices, outputs);
  const gateReady = f.done || f.blocked.length > 0;
  const decided = gateRow(ctx, props.gateId);

  return (
    <Sequence label={`${props.milestone} phase`}>
      <PortCampaign ctx={ctx} c={c} phase={props.milestone} slices={props.slices} />
      {props.extra ?? null}
      {gateReady ? (props.evidence ?? null) : null}
      {gateReady ? (
        <Sequence>
          <CampaignGate
            id={props.gateId}
            summary={`${props.milestone}: ${f.landed.length}/${f.total} slices landed; ratchet ${f.ledger.passingCount}/${f.ledger.totalCount}. Blocked lanes: ${f.blocked.map((b) => b.id).join(", ") || "none"}.${props.summary ? `\n\n${props.summary}` : ""}\n\nEvidence: frcLand, frcVerify, frcReview, and frcSuite rows. Blocked lanes are red evidence — approving with blocked lanes means accepting the documented gap.`}
          />
          {decided?.approved ? (
            <ContinueAsNew
              state={{
                milestone: NEXT[props.milestone],
                spentCents: c.spentCents,
                lineage: [...c.lineage, ctx.runId],
              }}
            />
          ) : decided?.approved === false ? (
            // Denial must REACH this branch, which is why exit gates are
            // onDeny:"continue" rather than "fail": "fail" aborts the run before
            // the mandated signed closeout can render, so a killed campaign would
            // end silently instead of publishing its post-mortem.
            <Closeout
              ctx={ctx}
              c={c}
              reason={`${props.milestone} exit gate denied by the operator: ${f.landed.length}/${f.total} slices landed, blocked lanes: ${f.blocked.map((b) => b.id).join(", ") || "none"}.`}
            />
          ) : null}
        </Sequence>
      ) : null}
    </Sequence>
  );
}
