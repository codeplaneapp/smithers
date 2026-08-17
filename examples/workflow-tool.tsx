/** @jsxImportSource smthrs */
import { OpenAIAgent, Task, Workflow, workflowTool } from "smthrs";
import { z } from "zod";
import { createExampleSmithers } from "./_example-kit.js";

const { smithers, outputs } = createExampleSmithers({
  input: z.object({ topic: z.string().default("durable workflows") }),
  research: z.object({ summary: z.string() }),
  answer: z.object({ answer: z.string() }),
});

const researchWorkflow = smithers(
  (ctx) => (
    <Workflow name="research-topic">
      <Task id="research" output={outputs.research}>
        {{ summary: `${(ctx.input as { topic: string }).topic} can be composed as a durable child run.` }}
      </Task>
    </Workflow>
  ),
  { output: outputs.research },
);

const researchTopic = workflowTool({
  name: "research_topic",
  description: "Run the durable research workflow for a topic.",
  workflow: researchWorkflow,
});

const agent = new OpenAIAgent({
  id: "workflow-tool-agent",
  model: "gpt-5-mini",
  instructions: "Call research_topic, then answer using the returned summary.",
  tools: { research_topic: researchTopic },
});

export default smithers(
  (ctx) => (
    <Workflow name="agent-calls-workflow">
      <Task id="answer" output={outputs.answer} agent={agent}>
        {`Research ${(ctx.input as { topic: string }).topic} and explain the result.`}
      </Task>
    </Workflow>
  ),
  { output: outputs.answer },
);
