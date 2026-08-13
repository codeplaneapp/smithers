/** @jsxImportSource smthrs */
/**
 * approval-demo - the run parks at a human gate, then applies the approved
 * change inside a booted stereOS VM.
 *
 * The `<Approval>` is a host concern: the engine leaves the run in
 * `waiting-approval` until a decision arrives through the gateway. The guard
 * accepts that decision only from whoever holds the run's start token. The
 * `<Sandbox>` that follows runs the authorized work in the guest.
 */
import { Approval, createSmithers, Sandbox, Sequence } from "smthrs";
import { z } from "zod";
import childWorkflow, { applyResultSchema } from "../guest-apply.tsx";
import { createStereosProvider } from "../stereos-provider.ts";

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({ change: z.string().default("write approved-change.txt in the guest workspace") }),
  // The engine writes { approved, decidedBy, decidedAt, note } and sets
  // decidedBy to null for an unattributed decision, so these fields must be
  // nullish rather than optional.
  decision: z.object({
    approved: z.boolean(),
    decidedBy: z.string().nullish(),
    note: z.string().nullish(),
  }),
  applied: applyResultSchema,
});

const provider = createStereosProvider({ id: "approval", guestEntry: "guest-apply.tsx" });

export default smithers((ctx) => {
  // The gate's own output decides whether the guest work is authorized. A
  // denial skips the Sandbox entirely, so nothing runs in the VM.
  const decision = ctx.outputMaybe("decision", { nodeId: "gate" });
  // Gateway UI discovery renders with no input, so read it defensively.
  const change = ctx.input?.change ?? "write approved-change.txt in the guest workspace";
  return (
    <Workflow name="approval-demo">
      <Sequence>
        <Approval
          id="gate"
          output={outputs.decision}
          request={{
            title: "Apply the change inside the stereOS VM?",
            summary: `This run stays paused until someone decides: ${change}`,
          }}
        />

        <Sandbox
          id="stereos-vm"
          provider={provider}
          workflow={childWorkflow}
          input={{ change: change, approved: decision?.approved === true }}
          output={outputs.applied}
          skipIf={decision != null && decision.approved !== true}
          allowNetwork
          reviewDiffs={false}
          timeoutMs={120_000}
          retries={1}
        />
      </Sequence>
    </Workflow>
  );
});
