/** @jsxImportSource smthrs */
// The run pauses at the Approval gate until a human decides. The decision
// arrives from the gateway, so the embedded web app can unblock this run by
// clicking Approve.
import { Approval, openSmithersBackend, Sequence, Task } from "smthrs";
import { z } from "zod";

const { Workflow, smithers, outputs } = await openSmithersBackend({
  input: z.object({ change: z.string() }),
  // The engine writes { approved, decidedBy, decidedAt, note } and sets
  // decidedBy to null for an unattributed decision, so these fields must be
  // nullish rather than optional.
  decision: z.object({
    approved: z.boolean(),
    decidedBy: z.string().nullish(),
    note: z.string().nullish(),
  }),
  applied: z.object({ status: z.string(), change: z.string() }),
});

export default smithers((ctx) => (
  <Workflow name="approval-demo">
    <Sequence>
      <Approval
        id="gate"
        output={outputs.decision}
        request={{
          title: "Apply the change?",
          summary: `This run stays paused until someone decides: ${ctx.input.change}`,
        }}
      />

      <Task id="apply" output={outputs.applied} deps={{ gate: outputs.decision }}>
        {(deps) => ({
          status: deps.gate.approved ? "applied" : "skipped",
          change: ctx.input.change,
        })}
      </Task>
    </Sequence>
  </Workflow>
));
