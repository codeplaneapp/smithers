// smithers-source: authored
// smithers-display-name: Plue Demo Child
// smithers-description: Tiny self-contained demo workflow shipped to a Plue Microsandbox VM by run-on-plue.tsx.
/** @jsxImportSource smthrs */
import { ClaudeCodeAgent, CodexAgent, createSmithers } from "smthrs";
import { z } from "zod/v4";

/**
 * Plue Demo Child — SELF-CONTAINED on purpose (no `../agents` import): this
 * is the exact file shipped verbatim to the remote VM by the plue sandbox
 * provider, so it must define its own env-authenticated agents and have no
 * dependency on anything outside this one file.
 *
 * Two trivial sequential tasks, minimal tokens. Both use the same Codex-first
 * Luna chain, so a healthy Codex account prevents Claude from running while a
 * VM without usable Codex auth can still complete through the fallback.
 */

const luna = [
  new CodexAgent({
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    skipGitRepoCheck: true,
  }),
  new ClaudeCodeAgent({ model: "claude-sonnet-5" }),
];

const answerSchema = z.object({
  answer: z.string().describe("A short, direct answer."),
});

const outputSchema = z.object({
  firstAnswer: z.string(),
  secondAnswer: z.string(),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  firstStep: answerSchema,
  secondStep: answerSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  const firstStep = ctx.outputMaybe("firstStep", { nodeId: "ask-first" });
  const secondStep = ctx.outputMaybe("secondStep", { nodeId: "ask-second" });

  return (
    <Workflow name="plue-demo-child">
      <Sequence>
        <Task id="ask-first" output={outputs.firstStep} agent={luna}>
          What is 2 + 2? Answer with just the number.
        </Task>
        <Task id="ask-second" output={outputs.secondStep} agent={luna}>
          What is the capital of France? Answer with just the city name.
        </Task>
        {firstStep && secondStep ? (
          <Task id="output" output={outputs.output}>
            {() => ({ firstAnswer: firstStep.answer, secondAnswer: secondStep.answer })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
