// Example only: ticket-create is preserved here instead of being installed by default.
// Turn one request into a scoped implementation ticket. It remains an example because the curated init pack installs only authoring and documentation workflows. Run `smithers graph examples/init-pack/ticket-create.tsx` after copying it into a project.
// Copy this implementation and its referenced .smithers prompts/components/UI/lib files into a project to use it.
// smithers-source: seeded
// smithers-display-name: Ticket Create
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import TicketPrompt from "../prompts/ticket.mdx";

const ticketCreateOutputSchema = z.looseObject({
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  prompt: z.string().default("Create a ticket for the requested work."),
});

const { Workflow, Task, smithers } = createSmithers({
  input: inputSchema,
  ticket: ticketCreateOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name="ticket-create">
    <UI entry="../ui/ticket-create.tsx" title={"Ticket Create"} />
    <Task id="ticket" output={ticketCreateOutputSchema} agent={agents.planning}>
      <TicketPrompt prompt={ctx.input.prompt} />
    </Task>
  </Workflow>
));
