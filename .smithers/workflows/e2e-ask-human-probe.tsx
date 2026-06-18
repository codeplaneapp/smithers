// smithers-source: e2e
// smithers-display-name: E2E Ask Human Probe
/** @jsxImportSource smithers-orchestrator */
import { HumanTask, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

// The human's answer is a single string field. The engine stores this as a
// `kind: "json"` durable human request whose schemaJson requires an object with
// an `answer` string, so the TUI/`smithers human` answer must be valid JSON like
// {"answer":"<text>"}.
const askSchema = z.object({
  answer: z.string(),
});

const consumedOutputSchema = z.object({
  marker: z.string(),
  answer: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  ask: askSchema,
  consumed: consumedOutputSchema,
});

export default smithers((ctx) => {
  const ask = ctx.outputMaybe(outputs.ask, { nodeId: "ask-probe" });

  return (
    <Workflow name="e2e-ask-human-probe">
      <HumanTask
        id="ask-probe"
        output={outputs.ask}
        outputSchema={askSchema}
        maxAttempts={10}
        prompt={
          "Answer the E2E ask probe. Reply with JSON: " +
          '{"answer":"<any non-empty string>"}.'
        }
      />

      {ask ? (
        <Task id="consume-task" output={outputs.consumed}>
          {async () => ({
            marker: "ask-human-consume-task-ran",
            answer: ask.answer,
          })}
        </Task>
      ) : null}
    </Workflow>
  );
});
