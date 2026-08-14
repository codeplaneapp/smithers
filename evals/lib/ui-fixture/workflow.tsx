// smithers-source: eval-fixture
// smithers-display-name: UI Eval Fixture
/** @jsxImportSource smthrs */
// The deterministic fixture a ui-functional eval runs the candidate UI against.
// Every task here is a COMPUTE task (no agent) so the run is reproducible on a
// CI box with no agent CLIs. In one run it exercises every surface a good
// Smithers workflow UI must handle:
//   • plan / build / report  — three tasks that emit live node events + output
//   • flaky                  — a task that THROWS (continueOnFail) so the UI has
//                              a real failed node to surface (the error case)
//   • signoff                — an <Approval> gate, so the run parks
//                              `waiting-approval` with a pending gate the UI can
//                              approve/deny; approving resumes it to `finished`
// The literal output strings below are the assertion contract: a UI that truly
// read + rendered node output will show them in the DOM.
import { Approval, createSmithers } from "smthrs";
import { z } from "zod/v4";

const planSchema = z.object({ steps: z.array(z.string()), note: z.string() });
const buildSchema = z.object({ status: z.string(), filesChanged: z.number() });
const reportSchema = z.object({ headline: z.string(), summary: z.string() });
const approvalSchema = z.object({ approved: z.boolean(), note: z.string().optional() });
const finalizeSchema = z.object({ done: z.boolean(), marker: z.string() });

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  plan: planSchema,
  build: buildSchema,
  report: reportSchema,
  signoff: approvalSchema,
  finalize: finalizeSchema,
});

// Known markers the functional verifier asserts appear in the rendered DOM.
export const FIXTURE = {
  key: "ui-eval-fixture",
  nodes: ["plan", "build", "flaky", "report", "signoff"],
  reportHeadline: "Release Ready",
  reportText: "shipped 3 features and fixed 2 bugs",
  errorText: "intentional failure: upstream dependency timed out",
  approvalTitle: "Approve the release",
} as const;

export default smithers((ctx) => {
  const approval = ctx.outputMaybe(outputs.signoff, { nodeId: "signoff" });

  return (
    <Workflow name="ui-eval-fixture">
      <Sequence>
        <Task id="plan" output={outputs.plan}>
          {async () => ({ steps: ["inspect", "design", "build"], note: "planned the release" })}
        </Task>

        <Task id="build" output={outputs.build}>
          {async () => ({ status: "built", filesChanged: 7 })}
        </Task>

        {/* The error case: a task that fails. continueOnFail keeps the run going
            so the UI can render this failed node alongside the healthy ones. */}
        <Task id="flaky" output={outputs.build} continueOnFail retries={0}>
          {async () => {
            throw new Error(FIXTURE.errorText);
          }}
        </Task>

        <Task id="report" output={outputs.report}>
          {async () => ({
            headline: FIXTURE.reportHeadline,
            summary: `Release notes: ${FIXTURE.reportText}.`,
          })}
        </Task>

        {/* Parks the run `waiting-approval` with a pending gate for the UI. */}
        <Approval
          id="signoff"
          output={outputs.signoff}
          request={{
            title: FIXTURE.approvalTitle,
            summary: "Approving this gate resumes the run and lets the final task complete.",
          }}
          onDeny="fail"
        />

        {approval?.approved ? (
          <Task id="finalize" output={outputs.finalize}>
            {async () => ({ done: true, marker: "release-shipped" })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
