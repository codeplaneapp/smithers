// smithers-source: seeded
// smithers-display-name: Tickets Create
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const ticketsCreateOutputSchema = z.object({
  summary: z.string(),
  tickets: z.array(z.object({
    title: z.string(),
    description: z.string(),
    acceptanceCriteria: z.array(z.string()).default([]),
  })).default([]),
}).passthrough();

const inputSchema = z.object({
  prompt: z.string().default("Create tickets for the requested work."),
});

const { Workflow, Task, smithers } = createSmithers({
  input: inputSchema,
  tickets: ticketsCreateOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name="tickets-create">
    <Task id="tickets" output={ticketsCreateOutputSchema} agent={agents.smart}>
      {`Break the following request into well-defined tickets with titles, descriptions, and acceptance criteria.\n\nRequest: ${ctx.input.prompt}`}
    </Task>
  </Workflow>
));
