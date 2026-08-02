/** @jsxImportSource smthrs */
import { Approval } from "smthrs";
import { outputs } from "./ferricSmithers";
import { APPROVAL_SLA, GATE_REGISTRY, type FerricGateId } from "./ferricGates";

/**
 * Resolve a gate's durable node id.
 *
 * `instance` exists for gates that can legitimately fire more than once in a
 * campaign. An approval row is keyed by (run, node, iteration), so a gate with a
 * STATIC id is answered exactly once and every later occurrence reads that same
 * stored `approved: true` — a one-shot approval silently becomes a perpetual
 * auto-pass. That defeats the flagship "no gate auto-approves" invariant, and it
 * bit the ratchet-halt gate: clearing one regression cleared every future one.
 */
export const gateNodeId = (id: FerricGateId, instance?: string | number) =>
  instance === undefined ? id : `${id}:${instance}`;

/**
 * The ONLY `Approval` mount in the campaign.
 *
 * The foundation task greps every campaign source file at runtime and fails the
 * run if a second approval site or any auto-approve option ever appears, so this
 * component is the enforcement point for "every gate is human".
 */
export function CampaignGate(props: {
  id: FerricGateId;
  summary: string;
  /** Distinguishes repeat firings of a re-armable gate (e.g. a halt epoch). */
  instance?: string | number;
}) {
  const reg = GATE_REGISTRY[props.id];
  return (
    <Approval
      id={gateNodeId(props.id, props.instance)}
      output={outputs.frcGate}
      onDeny={reg.onDeny}
      request={{
        title: reg.title,
        summary: props.summary,
        metadata: {
          sla: APPROVAL_SLA,
          neverAutoApprove: true,
          gateId: props.id,
          ...(props.instance === undefined ? {} : { instance: String(props.instance) }),
        },
      }}
    />
  );
}

/** Read a gate's persisted decision, or undefined while it is still pending. */
export const gateRow = (ctx: any, id: FerricGateId, instance?: string | number) =>
  ctx.outputMaybe(outputs.frcGate, { nodeId: gateNodeId(id, instance) });
