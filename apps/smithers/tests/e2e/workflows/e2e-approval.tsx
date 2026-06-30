// smithers-display-name: E2E Approval
/** @jsxImportSource smithers-orchestrator */
import { Approval, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

// A static, no-agent workflow that suspends at a human approval gate. Launching
// it seeds a WAITING run plus a PENDING approval the UI can approve/deny. CI-safe.
const { Workflow, Task, smithers, outputs } = createSmithers({
  approval: z.object({ approved: z.boolean(), note: z.string().optional() }),
  gated: z.object({ marker: z.string() }),
});

export default smithers((ctx) => {
  const approval = ctx.outputMaybe(outputs.approval, { nodeId: "gate" });
  return (
    <Workflow name="e2e-approval">
      <Approval
        id="gate"
        output={outputs.approval}
        request={{
          title: "Approve the deploy",
          summary: "Approving this gate lets the gated task run.",
        }}
        onDeny="fail"
      />
      {approval?.approved ? (
        <Task id="gated" output={outputs.gated}>
          {async () => ({ marker: "approval-gated-task-ran" })}
        </Task>
      ) : null}
    </Workflow>
  );
});
