// Example only: tickets-create is preserved here instead of being installed by default.
// Break a project request into a batch of actionable tickets. It remains an example because the curated init pack installs only authoring and documentation workflows. Run `smithers graph examples/init-pack/tickets-create.tsx` after copying it into a project.
// Copy this implementation and its referenced .smithers prompts/components/UI/lib files into a project to use it.
// smithers-source: seeded
// smithers-display-name: Tickets Create
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import TicketsCreatePrompt from "../prompts/tickets-create.mdx";

const ticketsCreateOutputSchema = z.looseObject({
  summary: z.string(),
  tickets: z.array(z.object({
    title: z.string(),
    description: z.string(),
    acceptanceCriteria: z.array(z.string()).default([]),
  })).default([]),
});

const inputSchema = z.object({
  prompt: z.string().default("Create tickets for the requested work."),
});

const { Workflow, Task, smithers } = createSmithers({
  input: inputSchema,
  tickets: ticketsCreateOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name="tickets-create">
    <UI entry="../ui/tickets-create.tsx" title={"Tickets Create"} />
    <Task id="tickets" output={ticketsCreateOutputSchema} agent={agents.planning}>
      <TicketsCreatePrompt prompt={ctx.input.prompt} />
    </Task>
  </Workflow>
));
