// Example only: hello is preserved here instead of being installed by default.
// Run the smallest possible workflow to verify a Smithers installation. It remains an example because the curated init pack installs only authoring and documentation workflows. Run `smithers graph examples/init-pack/hello.tsx` after copying it into a project.
// Copy this implementation and its referenced .smithers prompts/components/UI/lib files into a project to use it.
// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Hello World
// smithers-description: The smallest possible workflow: one agent task that runs the prompt in .smithers/prompts/hello.mdx. Your starting point for authoring your own.
// smithers-tags: starter, hello-world
/** @jsxImportSource smthrs */
import { UI } from "smthrs";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";
import HelloPrompt from "../prompts/hello.mdx";

// What you pass in. `name` defaults to "world" so `workflow run hello` works
// with no arguments at all.
const inputSchema = z.object({
  name: z
    .string()
    .default("world")
    .describe("Who to greet. Set it via the --input JSON; defaults to world."),
});

// What the agent must return: a single structured field, validated for you.
const greetingSchema = z.object({
  greeting: z.string().describe("A short, friendly one-sentence greeting."),
});

// The run's final output. The LAST task's output becomes the run output that
// `smithers up` / `workflow run` prints, so every workflow ends with a small
// deterministic task that surfaces the useful result instead of `output: null`.
const outputSchema = z.object({
  greeting: z.string().describe("The greeting the agent produced."),
  name: z.string().describe("Who was greeted."),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  greeting: greetingSchema,
  output: outputSchema,
});

/**
 * Hello World. Hand the agent the prompt in `.smithers/prompts/hello.mdx` (edit
 * that file to change what it does), capture its structured `greeting`, then end
 * with an `output` task that surfaces the result as the run's printed output.
 * This is the template to copy when you write your own workflow.
 *
 * Input fields arrive null when unsupplied, so coalesce `name` to its default.
 */
export default smithers((ctx) => {
  const name = ctx.input.name ?? "world";
  const greet = ctx.outputMaybe("greeting", { nodeId: "greet" });
  return (
    <Workflow name="hello">
      <UI entry="../ui/hello.tsx" title={"Hello World"} />
      <Sequence>
        <Task id="greet" output={outputs.greeting} agent={agents.cheapFast}>
          <HelloPrompt name={name} />
        </Task>
        {greet ? (
          <Task id="output" output={outputs.output}>
            {() => ({ greeting: greet.greeting, name })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
