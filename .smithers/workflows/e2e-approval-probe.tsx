// smithers-source: e2e
// smithers-display-name: E2E Approval Probe
/** @jsxImportSource smthrs */
import { UI } from "smthrs";
import { Approval, createSmithers } from "smthrs";
import { z } from "zod/v4";

const approvalSchema = z.object({
  approved: z.boolean(),
  note: z.string().optional(),
});

const gatedOutputSchema = z.object({
  marker: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  approval: approvalSchema,
  gated: gatedOutputSchema,
});

export default smithers((ctx) => {
  const approval = ctx.outputMaybe(outputs.approval, { nodeId: "approve-probe" });

  return (
    <Workflow name="e2e-approval-probe">
      <UI entry="../ui/e2e-approval-probe.tsx" title={"E2E Approval Probe"} />
      <Approval
        id="approve-probe"
        output={outputs.approval}
        request={{
          title: "Approve E2E gated task",
          summary: "Approving this request lets the static gated task mount and finish.",
        }}
        onDeny="fail"
      />

      {approval?.approved ? (
        <Task id="gated-task" output={outputs.gated}>
          {async () => ({ marker: "approval-gated-task-ran" })}
        </Task>
      ) : null}
    </Workflow>
  );
});
